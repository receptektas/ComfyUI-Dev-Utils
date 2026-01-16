import time

import torch
import inspect
import execution
import server


class ExecutionTime:
    CATEGORY = "TyDev-Utils/Debug"

    @classmethod
    def INPUT_TYPES(s):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "process"

    def process(self):
        return ()


CURRENT_START_EXECUTION_DATA = None


def get_peak_memory():
    if not torch.cuda.is_available():
        return 0
    device = torch.device('cuda')
    return torch.cuda.max_memory_allocated(device)


def reset_peak_memory_record():
    if not torch.cuda.is_available():
        return
    device = torch.device('cuda')
    torch.cuda.reset_max_memory_allocated(device)


def handle_execute(prompt_id, server, unique_id):
    """
    Called after each node execution completes.
    Sends timing data to frontend for the completed node.
    """
    if not CURRENT_START_EXECUTION_DATA:
        return
    
    start_time = CURRENT_START_EXECUTION_DATA['nodes_start_perf_time'].get(unique_id)
    start_vram = CURRENT_START_EXECUTION_DATA['nodes_start_vram'].get(unique_id, 0)
    
    if start_time is None:
        return
    
    end_time = time.perf_counter()
    execution_time = end_time - start_time
    
    end_vram = get_peak_memory()
    vram_used = max(0, end_vram - start_vram)
    
    # Send execution completed event for this node
    if server.client_id is not None:
        server.send_sync(
            "TyDev-Utils.ExecutionTime.executed",
            {
                "node": unique_id,
                "prompt_id": prompt_id,
                "execution_time": int(execution_time * 1000),
                "vram_used": vram_used
            },
            server.client_id
        )
    
    # Clean up the start time entry
    CURRENT_START_EXECUTION_DATA['nodes_start_perf_time'].pop(unique_id, None)
    CURRENT_START_EXECUTION_DATA['nodes_start_vram'].pop(unique_id, None)


try:
    origin_execute = execution.execute

    if inspect.iscoroutinefunction(origin_execute):
        async def dev_utils_execute(server, dynprompt, caches, current_item, extra_data, executed, prompt_id,
                                    execution_list, pending_subgraph_results, pending_async_nodes, *args, **kwargs):
            unique_id = current_item
            result = await origin_execute(server, dynprompt, caches, current_item, extra_data, executed, prompt_id,
                                          execution_list, pending_subgraph_results, pending_async_nodes, *args, **kwargs)
            handle_execute(prompt_id, server, unique_id)
            return result
    else:
        def dev_utils_execute(server, dynprompt, caches, current_item, extra_data, executed, prompt_id,
                              execution_list, pending_subgraph_results, *args, **kwargs):
            unique_id = current_item
            result = origin_execute(server, dynprompt, caches, current_item, extra_data, executed, prompt_id,
                                    execution_list, pending_subgraph_results, *args, **kwargs)
            handle_execute(prompt_id, server, unique_id)
            return result

    execution.execute = dev_utils_execute
except Exception as e:
    pass

# region: Deprecated (old ComfyUI versions)
try:
    origin_recursive_execute = execution.recursive_execute

    def dev_utils_origin_recursive_execute(server, prompt, outputs, current_item, extra_data, executed, prompt_id,
                                           outputs_ui, object_storage):
        unique_id = current_item
        result = origin_recursive_execute(server, prompt, outputs, current_item, extra_data, executed, prompt_id,
                                          outputs_ui, object_storage)
        handle_execute(prompt_id, server, unique_id)
        return result

    execution.recursive_execute = dev_utils_origin_recursive_execute
except Exception as e:
    pass
# endregion

origin_func = server.PromptServer.send_sync


def send_execution_end_event(self, data, sid):
    """
    Sends the execution_end event and resets the execution state.
    This is called when execution completes (success, error, or normal completion).
    """
    global CURRENT_START_EXECUTION_DATA
    
    if not CURRENT_START_EXECUTION_DATA:
        return
    
    # Determine the client ID to send to
    target_sid = sid if sid is not None else getattr(self, 'client_id', None)
    if target_sid is None:
        # Reset state even if we can't send the event
        CURRENT_START_EXECUTION_DATA = None
        return
    
    start_perf_time = CURRENT_START_EXECUTION_DATA.get('start_perf_time')
    new_data = data.copy() if data else {}
    
    if start_perf_time is not None:
        execution_time = time.perf_counter() - start_perf_time
        new_data['execution_time'] = int(execution_time * 1000)
    
    origin_func(
        self,
        event="TyDev-Utils.ExecutionTime.execution_end",
        data=new_data,
        sid=target_sid
    )
    
    # Reset the execution state to prevent duplicate events
    CURRENT_START_EXECUTION_DATA = None


def dev_utils_send_sync(self, event, data, sid=None):
    global CURRENT_START_EXECUTION_DATA
    
    if event == "execution_start":
        CURRENT_START_EXECUTION_DATA = dict(
            start_perf_time=time.perf_counter(),
            nodes_start_perf_time={},
            nodes_start_vram={}
        )

    # Call the original function first
    origin_func(self, event=event, data=data, sid=sid)

    # Handle execution completion via "executing" event with node=None
    if event == "executing" and data and CURRENT_START_EXECUTION_DATA:
        if data.get("node") is None:
            # Execution completed normally
            send_execution_end_event(self, data, sid)
        else:
            # Node execution started - record start time
            node_id = data.get("node")
            CURRENT_START_EXECUTION_DATA['nodes_start_perf_time'][node_id] = time.perf_counter()
            reset_peak_memory_record()
            CURRENT_START_EXECUTION_DATA['nodes_start_vram'][node_id] = get_peak_memory()
    
    # Fallback: Handle execution_error event
    elif event == "execution_error" and CURRENT_START_EXECUTION_DATA:
        send_execution_end_event(self, data, sid)
    
    # Fallback: Handle execution_success event (newer ComfyUI versions)
    elif event == "execution_success" and CURRENT_START_EXECUTION_DATA:
        send_execution_end_event(self, data, sid)


server.PromptServer.send_sync = dev_utils_send_sync

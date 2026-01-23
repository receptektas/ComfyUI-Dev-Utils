import {api} from "../../../scripts/api.js";
import {app} from "../../../scripts/app.js";
import {$el} from "../../scripts/ui.js";

// region: Refresh Timer
let refreshTimer = null;
let executionStartTime = null;
let currentExecutingNodeId = null;  // Track currently executing node

function stopRefreshTimer() {
    if (!refreshTimer) {
        return;
    }
    clearInterval(refreshTimer);
    refreshTimer = null;
}

function startRefreshTimer() {
    stopRefreshTimer();
    executionStartTime = LiteGraph.getTime();
    refreshTimer = setInterval(function () {
        app.graph.setDirtyCanvas(true, false);
    }, 100);
}

/**
 * Stops the timer for a specific node and calculates its execution time.
 * Called when node execution completes (either by next node starting or explicit completion).
 * @param {string|number} nodeId - The node ID whose timer should be stopped
 * @param {number|null} executionTime - Execution time in ms, or null to calculate from start time
 * @param {number|null} vramUsed - VRAM used in bytes, or null if not available
 */
function stopNodeTimer(nodeId, executionTime = null, vramUsed = null) {
    if (!nodeId) return;
    
    const node = app.graph.getNodeById(nodeId);
    if (!node) return;
    
    // Only process if this node has a start time (was actually running)
    if (node.ty_et_start_time === undefined) return;
    
    // Calculate execution time if not provided
    if (executionTime === null) {
        executionTime = LiteGraph.getTime() - node.ty_et_start_time;
    }
    
    // Set the final execution time
    node.ty_et_execution_time = executionTime;
    if (vramUsed !== null) {
        node.ty_et_vram_used = vramUsed;
    }
    
    // Clear start time to stop the live counter
    delete node.ty_et_start_time;
    
    // Update running data if available
    if (runningData) {
        const index = runningData.nodes_execution_time.findIndex(x => x.node === nodeId);
        const data = {
            node: nodeId,
            execution_time: executionTime,
            vram_used: vramUsed ?? 0
        };
        if (index >= 0) {
            runningData.nodes_execution_time[index] = data;
        } else {
            runningData.nodes_execution_time.push(data);
        }
    }
}

/**
 * Handles execution completion from any source.
 * Calculates execution time if not provided.
 * @param {number|null} executionTime - Execution time in ms, or null to calculate from start time
 */
function handleExecutionEnd(executionTime = null) {
    // Stop the currently executing node's timer first
    if (currentExecutingNodeId) {
        stopNodeTimer(currentExecutingNodeId, null, null);
        currentExecutingNodeId = null;
    }
    
    stopRefreshTimer();
    
    if (runningData) {
        // Calculate execution time if not provided
        if (executionTime === null && executionStartTime !== null) {
            executionTime = LiteGraph.getTime() - executionStartTime;
        }
        
        // Only update if we have a valid execution time and haven't already completed
        if (executionTime !== null && runningData.total_execution_time === null) {
            runningData.total_execution_time = executionTime;
            refreshTable();
        }
    }
    
    // Clear any remaining node start times to stop individual counters
    if (app.graph?._nodes) {
        app.graph._nodes.forEach(function (node) {
            delete node.ty_et_start_time;
        });
    }
    
    executionStartTime = null;
}


// endregion

function formatExecutionTime(time) {
    return `${(time / 1000.0).toFixed(2)}s`
}

// Reference: https://gist.github.com/zentala/1e6f72438796d74531803cc3833c039c
function formatBytes(bytes, decimals) {
    // Handle invalid values (undefined, null, NaN, negative)
    if (bytes == null || isNaN(bytes) || bytes < 0) {
        return 'N/A';
    }
    if (bytes === 0) {
        return '0 B';
    }
    const k = 1024,
        dm = decimals || 2,
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        i = Math.floor(Math.log(bytes) / Math.log(k));
    
    // Safeguard against out-of-bounds index
    if (i < 0 || i >= sizes.length) {
        return 'N/A';
    }
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


// Reference: https://github.com/ltdrdata/ComfyUI-Manager/blob/main/js/comfyui-manager.js
function drawBadge(node, orig, restArgs) {
    let ctx = restArgs[0];
    const r = orig?.apply?.(node, restArgs);

    if (!node.flags.collapsed && node.constructor.title_mode != LiteGraph.NO_TITLE) {
        let text = "";
        if (node.ty_et_execution_time !== undefined) {
            const timeText = formatExecutionTime(node.ty_et_execution_time);
            const vramText = formatBytes(node.ty_et_vram_used, 2);
            // Only show vram if it's a valid, non-zero value
            if (node.ty_et_vram_used != null && node.ty_et_vram_used > 0) {
                text = `${timeText} - vram ${vramText}`;
            } else {
                text = timeText;
            }
        } else if (node.ty_et_start_time !== undefined) {
            text = formatExecutionTime(LiteGraph.getTime() - node.ty_et_start_time);
        }
        if (!text) {
            return;
        }
        const fgColor = "white";
        const bgColor = "#0F1F0F";

        ctx.save();
        ctx.font = "12px sans-serif";
        const textSize = ctx.measureText(text);
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        const paddingHorizontal = 6;
        ctx.roundRect(0, -LiteGraph.NODE_TITLE_HEIGHT - 20, textSize.width + paddingHorizontal * 2, 20, 5);
        ctx.fill();

        ctx.fillStyle = fgColor;
        ctx.fillText(text, paddingHorizontal, -LiteGraph.NODE_TITLE_HEIGHT - paddingHorizontal);
        ctx.restore();
    }
    return r;
}

// Reference: https://github.com/ltdrdata/ComfyUI-Manager/blob/main/js/common.js
async function unloadModelsAndFreeMemory() {
    let res = await api.fetchApi(`/free`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: '{"unload_models": true, "free_memory": true}'
    });

    if (res.status === 200) {
        app.ui.dialog.show('<span style="color: green;">Unload models and free memory success.</span>')
    } else {
        app.ui.dialog.show('[ERROR] Unload models and free memory fail.')
    }
    app.ui.dialog.element.style.zIndex = 10010;
}

function setupClearExecutionCacheMenu() {
    const menu = document.querySelector(".comfy-menu");
    const freeButton = document.createElement("button");
    freeButton.textContent = "Clear Execution Cache";
    freeButton.onclick = async () => {
        await unloadModelsAndFreeMemory();
    };

    menu.append(freeButton);
}


let lastRunningDate = null;
let runningData = null;


// https://stackoverflow.com/a/56370447
function exportTable(table, separator = ',') {
    // Select rows from table_id
    var rows = table.querySelectorAll('tr');
    // Construct csv
    var csv = [];
    for (var i = 0; i < rows.length; i++) {
        var row = [], cols = rows[i].querySelectorAll('td, th');
        for (var j = 0; j < cols.length; j++) {
            // Clean innertext to remove multiple spaces and jumpline (break csv)
            var data = cols[j].innerText.replace(/(\r\n|\n|\r)/gm, '').replace(/(\s\s)/gm, ' ')
            // Escape double-quote with double-double-quote (see https://stackoverflow.com/questions/17808511/properly-escape-a-double-quote-in-csv)
            data = data.replace(/"/g, '""');
            // Push escaped string
            row.push('"' + data + '"');
        }
        csv.push(row.join(separator));
    }
    var csv_string = csv.join('\n');
    // Download it
    var filename = 'execution_time' + new Date().toLocaleDateString() + '.csv';
    var link = document.createElement('a');
    link.style.display = 'none';
    link.setAttribute('target', '_blank');
    link.setAttribute('href', 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv_string));
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function buildTableHtml() {
    const tableBody = $el("tbody")
    const tableFooter = $el("tfoot", {style: {"background": "var(--comfy-input-bg)"}})
    const headerThStyle = {"white-space": "nowrap"}
    const table = $el("table", {
        textAlign: "right",
        border: "1px solid var(--border-color)",
        style: {"border": "none", "border-spacing": "0", "font-size": "14px", "width": "100%"}
    }, [
        $el("thead", {style: {"background": "var(--comfy-input-bg)"}}, [
            $el("tr", [
                $el("th", {style: headerThStyle, "textContent": "Node Id"}),
                $el("th", {style: headerThStyle, "textContent": "Node Title"}),
                $el("th", {style: headerThStyle, "textContent": "Current Time"}),
                $el("th", {style: headerThStyle, "textContent": "Per Time"}),
                $el("th", {style: headerThStyle, "textContent": "Cur / Pre Time Diff"}),
                $el("th", {style: headerThStyle, "textContent": "VRAM Used"})
            ])
        ]),
        tableBody,
        tableFooter
    ]);
    if (runningData?.nodes_execution_time === undefined) {
        return table;
    }

    function diff(current, pre) {
        let diffText;
        let diffColor;
        if (pre) {
            const diffTime = current - pre;
            const diffPercentText = `${(diffTime * 100 / pre).toFixed(2)}%`;
            if (diffTime > 0) {
                diffColor = 'red';
                diffText = `+${formatExecutionTime(diffTime)} / +${diffPercentText}`;
            } else if (diffPercentText === '0.00%') {
                diffColor = 'white';
                diffText = formatExecutionTime(diffTime);
            } else {
                diffColor = 'green';
                diffText = `${formatExecutionTime(diffTime)} / ${diffPercentText}`;
            }
        }
        return [diffColor, diffText]
    }

    let max_execution_time = null
    let max_vram_used = null

    runningData.nodes_execution_time.forEach(function (item) {
        const nodeId = item.node;
        const node = app.graph.getNodeById(nodeId)
        const title = node?.title ?? nodeId
        const preExecutionTime = lastRunningDate?.nodes_execution_time?.find(x => x.node === nodeId)?.execution_time

        const [diffColor, diffText] = diff(item.execution_time, preExecutionTime);

        if (max_execution_time == null || item.execution_time > max_execution_time) {
            max_execution_time = item.execution_time
        }

        if (max_vram_used == null || item.vram_used > max_vram_used) {
            max_vram_used = item.vram_used
        }

        tableBody.append($el("tr", {
            style: {"cursor": "pointer"},
            onclick: () => {
                if (node) {
                    app.canvas.selectNode(node, false);
                }
            }
        }, [
            $el("td", {style: {"textAlign": "right"}, "textContent": nodeId}),
            $el("td", {style: {"textAlign": "right"}, "textContent": title}),
            $el("td", {style: {"textAlign": "right"}, "textContent": formatExecutionTime(item.execution_time)}),
            $el("td", {
                style: {"textAlign": "right"},
                "textContent": preExecutionTime !== undefined ? formatExecutionTime(preExecutionTime) : undefined
            }),
            $el("td", {
                style: {
                    "textAlign": "right",
                    "color": diffColor
                },
                "textContent": diffText
            }),
            $el("td", {style: {"textAlign": "right"}, "textContent": formatBytes(item.vram_used, 2)}),
        ]))
    });
    if (runningData.total_execution_time !== null) {
        const [diffColor, diffText] = diff(runningData.total_execution_time, lastRunningDate?.total_execution_time);

         tableFooter.append($el("tr", [
            $el("td", {style: {"textAlign": "right"}, "textContent": 'Max'}),
            $el("td", {style: {"textAlign": "right"}, "textContent": ''}),
            $el("td", {
                style: {"textAlign": "right"},
                "textContent": max_execution_time != null ? formatExecutionTime(max_execution_time) : ''
            }),
            $el("td", {
                style: {"textAlign": "right"},
                "textContent": ''
            }),
            $el("td", {
                style: {
                    "textAlign": "right",
                    "color": diffColor
                },
                "textContent": ''
            }),
            $el("td", {
                style: {"textAlign": "right"},
                "textContent": max_vram_used != null ? formatBytes(max_vram_used, 2) : ''
            }),
        ]))

        tableFooter.append($el("tr", [
            $el("td", {style: {"textAlign": "right"}, "textContent": 'Total'}),
            $el("td", {style: {"textAlign": "right"}, "textContent": ''}),
            $el("td", {
                style: {"textAlign": "right"},
                "textContent": formatExecutionTime(runningData.total_execution_time)
            }),
            $el("td", {
                style: {"textAlign": "right"},
                "textContent": lastRunningDate?.total_execution_time ? formatExecutionTime(lastRunningDate?.total_execution_time) : undefined
            }),
            $el("td", {
                style: {
                    "textAlign": "right",
                    "color": diffColor
                },
                "textContent": diffText
            }),
            $el("td", {style: {"textAlign": "right"}, "textContent": ""}),
        ]))
    }
    return table;
}

function refreshTable() {
    app.graph._nodes.forEach(function (node) {
        if (node.comfyClass === "TY_ExecutionTime" && node.widgets) {
            const tableWidget = node.widgets.find((w) => w.name === "Table");
            if (!tableWidget) {
                return;
            }
            tableWidget.inputEl.replaceChild(buildTableHtml(), tableWidget.inputEl.firstChild);
            const computeSize = node.computeSize();
            const newSize = [Math.max(node.size[0], computeSize[0]), Math.max(node.size[1], computeSize[1])];
            node.setSize(newSize);
            app.graph.setDirtyCanvas(true);
        }
    });
}

app.registerExtension({
    name: "TyDev-Utils.ExecutionTime",
    async setup() {
        setupClearExecutionCacheMenu();
        
        // Listen for node execution start
        // Note: detail can be either a nodeId string directly, or an object {node: nodeId, prompt_id: ...}
        // depending on ComfyUI version
        api.addEventListener("executing", ({detail}) => {
            // Handle both formats: direct nodeId or object with node property
            const nodeId = (typeof detail === 'object' && detail !== null) ? detail?.node : detail;
            
            // If nodeId is null/undefined, execution has finished
            if (nodeId === null || nodeId === undefined) {
                // Stop the last executing node's timer
                if (currentExecutingNodeId) {
                    stopNodeTimer(currentExecutingNodeId, null, null);
                    currentExecutingNodeId = null;
                }
                
                // Handle workflow completion
                if (runningData && runningData.total_execution_time === null) {
                    handleExecutionEnd(null);
                }
                return;
            }
            
            // A new node is starting - stop the previous node's timer first
            if (currentExecutingNodeId && currentExecutingNodeId !== nodeId) {
                stopNodeTimer(currentExecutingNodeId, null, null);
            }
            
            // Start timer for the new node
            currentExecutingNodeId = nodeId;
            const node = app.graph.getNodeById(nodeId);
            if (node) {
                node.ty_et_start_time = LiteGraph.getTime();
            }
        });
        
        // Listen for native ComfyUI "executed" event (node completed)
        // This is sent when a node finishes execution successfully
        api.addEventListener("executed", ({detail}) => {
            if (!detail) return;
            
            const nodeId = (typeof detail === 'object' && detail !== null) ? detail?.node : detail;
            if (!nodeId) return;
            
            // Stop the timer for this node
            stopNodeTimer(nodeId, null, null);
            
            // Clear current executing node if it matches
            if (currentExecutingNodeId === nodeId) {
                currentExecutingNodeId = null;
            }
            
            refreshTable();
        });

        // Listen for individual node execution completion (custom event from backend with timing data)
        api.addEventListener("TyDev-Utils.ExecutionTime.executed", ({detail}) => {
            if (!detail || !runningData) {
                return;
            }
            
            // Use the detailed timing data from backend
            stopNodeTimer(detail.node, detail.execution_time, detail.vram_used);
            
            // Clear current executing node if it matches
            if (currentExecutingNodeId === detail.node) {
                currentExecutingNodeId = null;
            }
            
            refreshTable();
        });

        // Listen for execution start (workflow begins)
        api.addEventListener("execution_start", ({detail}) => {
            // If there's an ongoing execution that hasn't completed, don't restart
            if (runningData && runningData.total_execution_time === null) {
                return;
            }
            
            // Reset state for new execution
            currentExecutingNodeId = null;
            lastRunningDate = runningData;
            
            app.graph._nodes.forEach(function (node) {
                delete node.ty_et_start_time;
                delete node.ty_et_execution_time;
                delete node.ty_et_vram_used;
            });
            
            runningData = {
                nodes_execution_time: [],
                total_execution_time: null
            };
            startRefreshTimer();
        });

        // Listen for custom execution end event (primary mechanism)
        api.addEventListener("TyDev-Utils.ExecutionTime.execution_end", ({detail}) => {
            handleExecutionEnd(detail?.execution_time ?? null);
        });
        
        // Fallback: Listen for execution_success (native ComfyUI event)
        api.addEventListener("execution_success", ({detail}) => {
            if (runningData && runningData.total_execution_time === null) {
                handleExecutionEnd(null);
            }
        });
        
        // Fallback: Listen for execution_error (handle errors gracefully)
        api.addEventListener("execution_error", ({detail}) => {
            if (runningData && runningData.total_execution_time === null) {
                handleExecutionEnd(null);
            }
        });
        
        // Fallback: Listen for status changes (covers queue completion)
        api.addEventListener("status", ({detail}) => {
            // When queue becomes empty and we have an unfinished execution, complete it
            if (detail?.exec_info?.queue_remaining === 0) {
                if (runningData && runningData.total_execution_time === null) {
                    handleExecutionEnd(null);
                }
            }
        });
    },
    async nodeCreated(node, app) {
        if (!node.ty_et_swizzled) {
            let orig = node.onDrawForeground;
            if (!orig) {
                orig = node.__proto__.onDrawForeground;
            }

            node.onDrawForeground = function (ctx) {
                drawBadge(node, orig, arguments)
            };
            node.ty_et_swizzled = true;
        }
    },
    async loadedGraphNode(node, app) {
        if (!node.ty_et_swizzled) {
            const orig = node.onDrawForeground;
            node.onDrawForeground = function (ctx) {
                drawBadge(node, orig, arguments)
            };
            node.ty_et_swizzled = true;
        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType.comfyClass === "TY_ExecutionTime") {
            const originComputeSize = nodeType.prototype.computeSize || LGraphNode.prototype.computeSize;
            nodeType.prototype.computeSize = function () {
                const originSize = originComputeSize.apply(this, arguments);
                if (this.flags?.collapsed || !this.widgets) {
                    return originSize;
                }
                const tableWidget = this.widgets.find((w) => w.name === "Table");
                if (!tableWidget) {
                    return originSize;
                }
                const tableElem = tableWidget.inputEl.firstChild;
                const tableHeight = tableElem.getBoundingClientRect().height;
                const thHeight = tableElem.tHead.getBoundingClientRect().height;
                const thUnscaledHeight = 24;
                const tableUnscaledHeight = thUnscaledHeight * tableHeight / thHeight;
                const autoResizeMaxHeight = 300;
                return [Math.max(originSize[0], 600), originSize[1] + Math.min(tableUnscaledHeight, autoResizeMaxHeight) - LiteGraph.NODE_WIDGET_HEIGHT];
            }

            const nodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                nodeCreated?.apply(this, arguments);

                const tableWidget = {
                    type: "HTML",
                    name: "Table",
                    draw: function (ctx, node, widgetWidth, y, widgetHeight) {
                        const marginHorizontal = 14;
                        const marginTop = 0;
                        const marginBottom = 14;
                        const elRect = ctx.canvas.getBoundingClientRect();
                        const transform = new DOMMatrix()
                            .scaleSelf(elRect.width / ctx.canvas.width, elRect.height / ctx.canvas.height)
                            .multiplySelf(ctx.getTransform())
                            .translateSelf(marginHorizontal, marginTop + y);

                        const x = Math.max(0, Math.round(ctx.getTransform().a * (node.size[0] - this.inputEl.scrollWidth - 2 * marginHorizontal) / 2));
                        Object.assign(
                            this.inputEl.style,
                            {
                                transformOrigin: '0 0',
                                transform: transform,
                                left: `${x}px`,
                                top: `0px`,
                                position: "absolute",
                                width: `${widgetWidth - marginHorizontal * 2}px`,
                                height: `${node.size[1] - (marginTop + marginBottom) - y}px`,
                                overflow: `auto`,
                            }
                        );
                    },
                };
                tableWidget.inputEl = $el("div");

                document.body.appendChild(tableWidget.inputEl);

                this.addWidget("button", "Export CSV", "display: none", () => {
                    exportTable(tableWidget.inputEl.firstChild)
                });
                this.addCustomWidget(tableWidget);

                this.onRemoved = function () {
                    tableWidget.inputEl.remove();
                };
                this.serialize_widgets = false;
                this.isVirtualNode = true;

                const tableElem = buildTableHtml();

                tableWidget.inputEl.appendChild(tableElem)

                this.setSize(this.computeSize());
            }
        }
    }
});
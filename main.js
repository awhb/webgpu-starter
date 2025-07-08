async function main() {
    const GRID_SIZE = 32;
    const UPDATE_INTERVAL = 200; // Update every 200ms (5 times/sec)
    const WORKGROUP_SIZE = 8;

    const canvas = document.querySelector("#gpuCanvas");

    // Verify browser supports WebGPU
    if (!navigator.gpu) {
        document.querySelector('.no-webgpu').style.display = 'block';
    }

    // You can think of an adapter as WebGPU's representation of a specific piece of GPU hardware in your device.
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
    throw new Error("No appropriate GPUAdapter found.");
    }

    // Request GPUDevice, the main interface through which most interaction with the GPU happens.
    const device = await adapter.requestDevice();

    // Configure the HTML canvas to be used with the device you just created.
    const context = canvas.getContext("webgpu");
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
    device: device,
    format: canvasFormat,
    });

    // TypedArrays are a group of JavaScript objects that allows you to allocate contiguous blocks of memory 
    // and interpret each element in the series as a specific data type.
    // 1. Create an array that holds all of the vertex positions in the diagram 
    const vertices = new Float32Array([
        //   X,    Y,
        -0.8, -0.8, // Triangle 1 (Blue)
        0.8, -0.8,
        0.8,  0.8,

        -0.8, -0.8, // Triangle 2 (Red)
        0.8,  0.8,
        -0.8,  0.8,
    ]);


    // Any data you want the GPU to use while it draws needs to be placed in GPU's own memory, 
    // highly optimised for rendering
    const vertexBuffer = device.createBuffer({
        label: "Cell vertices",
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // copy the vertex data into the buffer's memory
    device.queue.writeBuffer(vertexBuffer, /*bufferOffset=*/0, vertices);

    // define the vertex data structure
    const vertexBufferLayout = {
    arrayStride: 8,
    attributes: [{
        format: "float32x2",
        offset: 0,
        shaderLocation: 0, // Position, see vertex shader
    }],
    };


    // if you have multiple pipelines that want to share resources, 
    // you need to create GPUBindGroupLayout explicitly, and then provide it to
    // both the bind group and pipelines.
    // Create the bind group layout and pipeline layout.
    const bindGroupLayout = device.createBindGroupLayout({
    label: "Cell Bind Group Layout",
    entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
        buffer: {} // Grid uniform buffer
    }, {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage"} // Cell state input buffer
    }, {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage"} // Cell state output buffer
    }]
    });

    const pipelineLayout = device.createPipelineLayout({
        label: "Cell Pipeline Layout",
        bindGroupLayouts: [ bindGroupLayout ],
    });


    // create shader module for render pipeline (renders the cells)
    const cellShaderModule = device.createShaderModule({
        label: "Cell shader",
        code: `
        struct VertexOutput {
            @builtin(position) position: vec4f,
            @location(0) cell: vec2f,
        };

        @group(0) @binding(0) var<uniform> grid: vec2f;
        @group(0) @binding(1) var<storage> cellState: array<u32>;

        @vertex
        fn vertexMain(@location(0) position: vec2f,
                      @builtin(instance_index) instance: u32) -> VertexOutput {
            var output: VertexOutput;

            let i = f32(instance);
            let cell = vec2f(i % grid.x, floor(i / grid.x));

            let scale = f32(cellState[instance]);
            let cellOffset = cell / grid * 2;
            let gridPos = (position*scale+1) / grid - 1 + cellOffset;

            output.position = vec4f(gridPos, 0, 1);
            output.cell = cell / grid;
            return output;
        }

        @fragment
        fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
            return vec4f(input.cell, 1.0 - input.cell.x, 1);
        }
        `
    });

    // shader module has to be used as part of GPURenderPipeline, controls 
    // controls how geometry is drawn, including things like which shaders are used,
    // how to interpret data in vertex buffers, which kind of geometry should be rendered
    // (lines, points, triangles...), and more!
    const cellPipeline = device.createRenderPipeline({
    label: "Cell pipeline",
    layout: pipelineLayout,
    vertex: {
        module: cellShaderModule,
        entryPoint: "vertexMain",
        buffers: [vertexBufferLayout]
    },
    fragment: {
        module: cellShaderModule,
        entryPoint: "fragmentMain",
        targets: [{
        format: canvasFormat
        }]
    }
    });

    // Create the compute shader that will process the game of life simulation.
    const simulationShaderModule = device.createShaderModule({
    label: "Life simulation shader",
    code: `
        @group(0) @binding(0) var<uniform> grid: vec2f;

        @group(0) @binding(1) var<storage> cellStateIn: array<u32>;
        @group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;

        fn cellIndex(cell: vec2u) -> u32 {
        return (cell.y % u32(grid.y)) * u32(grid.x) +
                (cell.x % u32(grid.x));
        }

        fn cellActive(x: u32, y: u32) -> u32 {
        return cellStateIn[cellIndex(vec2(x, y))];
        }

        @compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
        fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
        // Determine how many active neighbors this cell has.
        let activeNeighbors = cellActive(cell.x+1, cell.y+1) +
                                cellActive(cell.x+1, cell.y) +
                                cellActive(cell.x+1, cell.y-1) +
                                cellActive(cell.x, cell.y-1) +
                                cellActive(cell.x-1, cell.y-1) +
                                cellActive(cell.x-1, cell.y) +
                                cellActive(cell.x-1, cell.y+1) +
                                cellActive(cell.x, cell.y+1);

        let i = cellIndex(cell.xy);

        // Conway's game of life rules:
        switch activeNeighbors {
            case 2: { // Active cells with 2 neighbors stay active.
            cellStateOut[i] = cellStateIn[i];
            }
            case 3: { // Cells with 3 neighbors become or stay active.
            cellStateOut[i] = 1;
            }
            default: { // Cells with < 2 or > 3 neighbors become inactive.
            cellStateOut[i] = 0;
            }
        }
        }
    `
    });

    // Create a compute pipeline that updates the game state.
    const simulationPipeline = device.createComputePipeline({
    label: "Simulation pipeline",
    layout: pipelineLayout,
    compute: {
        module: simulationShaderModule,
        entryPoint: "computeMain",
    }
    });

    // Create a uniform buffer that describes the grid.
    const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
    const uniformBuffer = device.createBuffer({
    label: "Grid Uniforms",
    size: uniformArray.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

    // Create an array representing the active state of each cell.
    const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);

    // Create two storage buffers to hold the cell state.
    const cellStateStorage = [
        device.createBuffer({
            label: "Cell State A",
            size: cellStateArray.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        device.createBuffer({
            label: "Cell State B",
            size: cellStateArray.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
    ];

    // Set each cell to a random state, then copy the JavaScript array into
    // the storage buffer.
    for (let i = 0; i < cellStateArray.length; ++i) {
        cellStateArray[i] = Math.random() > 0.6 ? 1 : 0;
    }
    device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);


    // Create a bind group to pass the grid uniforms into the pipeline
    const bindGroups = [
    device.createBindGroup({
        label: "Cell renderer bind group A",
        layout: bindGroupLayout,
        entries: [{
            binding: 0,
            resource: { buffer: uniformBuffer }
        }, {
            binding: 1,
            resource: { buffer: cellStateStorage[0] }
        }, {
            binding: 2,
            resource: { buffer: cellStateStorage[1] }
        }],
    }),
    device.createBindGroup({
        label: "Cell renderer bind group B",
        layout: bindGroupLayout,
        entries: [{
            binding: 0,
            resource: { buffer: uniformBuffer }
        }, {
            binding: 1,
            resource: { buffer: cellStateStorage[1] }
        }, {
            binding: 2,
            resource: { buffer: cellStateStorage[0] }
        }],
    }),
    ];

    let step = 0; // Track how many simulation steps have been run
    function updateGrid() {
        // GPUCommandEncoder provides an interface for recording GPU commands.
        const encoder = device.createCommandEncoder();

        // Start a compute pass
        const computePass = encoder.beginComputePass();

        computePass.setPipeline(simulationPipeline);
        computePass.setBindGroup(0, bindGroups[step % 2]);
        const workgroupCount = Math.ceil(GRID_SIZE / WORKGROUP_SIZE);
        computePass.dispatchWorkgroups(workgroupCount, workgroupCount);
        computePass.end();

        step++; 

        // Each draw operation begins with a beginRenderPass() call, which defines the 
        // textures that receive the output of any drawing commands performed.
        const pass = encoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(), // can customise which part of texture to render to if needed
            loadOp: "clear", // clear texture when render pass starts
            clearValue: { r: 0, g: 0, b: 0.4, a: 1.0 },
            storeOp: "store", // save into texture results done during render pass
        }]
        });

        pass.setPipeline(cellPipeline);
        pass.setBindGroup(0, bindGroups[step % 2]); // Updated!
        pass.setVertexBuffer(0, vertexBuffer);
        pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE); // second argument is for instancing

        pass.end(); // end render pass

        // create GPUCommandBuffer, an opaque handle to the recorded commands and immediately the command buffer 
        // to the GPU using the queue of the GPUDevice (takes in an array of command buffers), 
        // since submitted command buffers cannot be used again
        device.queue.submit([encoder.finish()]);        
    }

    // Schedule updateGrid() to run repeatedly
    setInterval(updateGrid, UPDATE_INTERVAL);

}

window.onload = main;
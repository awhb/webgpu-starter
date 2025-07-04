
// Verify browser supports WebGPU
if (!navigator.gpu) {
    document.querySelector('.no-webgl2').style.display = 'block';
}

// You can think of an adapter as WebGPU's representation of a specific piece of GPU hardware in your device.
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("No appropriate GPUAdapter found.");
}

// Request GPUDevice, the main interface through which most interaction with the GPU happens.
const device = await adapter.requestDevice();

// Configure the HTML canvas to be used with the device you just created.
const canvas = document.querySelector("gpuCanvas");
const context = canvas.getContext("webgpu");
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure({
  device: device,
  format: canvasFormat,
});

// GPUCommandEncoder provides an interface for recording GPU commands.
const encoder = device.createCommandEncoder();

// Each draw operation begins with a beginRenderPass() call, which defines the 
// textures that receive the output of any drawing commands performed.
const pass = encoder.beginRenderPass({
  colorAttachments: [{
     view: context.getCurrentTexture().createView(), // can customise which part of texture to render to if needed
     loadOp: "clear", // clear texture when render pass starts
     storeOp: "store", // save into texture results done during render pass
  }]
});

pass.end(); // end render pass

// create GPUCommandBuffer, an opaque handle to the recorded commands
// const commandBuffer = encoder.finish();
// Submit the command buffer to the GPU using the queue of the GPUDevice (takes in an array of command buffers)
// device.queue.submit([commandBuffer]);

// or finish the command buffer and immediately submit it, since submitted command buffers cannot be used again
device.queue.submit([encoder.finish()]);


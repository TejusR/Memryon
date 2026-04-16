declare module "onnxruntime-node" {
  export class Tensor {
    constructor(
      type: string,
      data: BigInt64Array | Float32Array,
      dims: readonly number[]
    );

    data: BigInt64Array | Float32Array;
    dims: number[];
  }

  export class InferenceSession {
    static create(modelPath: string): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}

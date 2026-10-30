/**
 * The keys `dataflow.bt` reads that a person sets: the inputs a device running
 * it opens to writers outside it, each with its type, as `KeyMeta`.
 */
export const DATAFLOW_INPUTS = {
  "sensor/distance": { ty: "f32", editable: true },
  "face/smile_target": { ty: "f32", editable: true },
};

import { careEvents, type CareEventMap } from "./bus";

export function subscribePatientRefresh(
  patientId: string,
  onRefresh: (payload: CareEventMap["entry:changed"]) => void,
): () => void {
  return careEvents.on("entry:changed", (payload) => {
    if (payload.patientId === patientId) {
      onRefresh(payload);
    }
  });
}

export function notifyEntryChanged(payload: CareEventMap["entry:changed"]): void {
  careEvents.emit("entry:changed", payload);
}

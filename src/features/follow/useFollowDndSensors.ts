import { KeyboardSensor, MouseSensor, useSensor, useSensors } from "@dnd-kit/core";

/** Shared sensors for live-room and IPTV favorite grouping. */
export function useFollowDndSensors() {
  // ContextMenu owns touch long-press on the same card. A TouchSensor would
  // activate first and leave both DND and the modal menu handling one gesture,
  // so DND may still prevent native scrolling while the menu and route change
  // are being handled. Mobile users can move an item through the menu; mouse
  // and keyboard DND remain available.
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
}

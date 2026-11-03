import { createSignal } from "solid-js";

/**
 * Is this copy of PureCut held inside a page (a room, the Personal agent's)? The frame knows (held-frame.tsx) and the editor
 * reads it here. Nothing else decides what a held copy shows: the rules are in compact-in-room.css, and in the places that
 * would otherwise start work a person has not asked for here.
 */
export const [heldInRoom, setHeldInRoom] = createSignal(false);

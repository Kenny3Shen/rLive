/**
 * Isolated entry point for motion's DOM feature bundle.
 *
 * This file exists only so `MotionProvider` has a splittable target for its
 * dynamic import. Re-exporting `domAnimation` from a module that also imports
 * `LazyMotion` defeats the split (Rolldown reports INEFFECTIVE_DYNAMIC_IMPORT
 * and keeps everything in one chunk), so nothing else may be added here.
 */
export { domAnimation as default } from "motion/react";

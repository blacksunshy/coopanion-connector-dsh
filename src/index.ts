/** Package entry: DSH loads the bundle patch, whose row names this module, and reads the default export. */
export { default } from './plugin.ts';
export { PET_PATH, PROTOCOL_VERSION, PetHub } from './pet-hub.ts';
export { AgentRegistry, noticeOf } from './session-watch.ts';
export { assistantText, parsePetFrame, reasonText } from './protocol.ts';
export type { HostFrame, PetFrame } from './protocol.ts';

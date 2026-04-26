/**
 * StageLinQ service names and connection constants.
 *
 * After discovery, devices expose a Directory service over TCP. The Directory
 * advertises which services are available and their ports. Each service then
 * has its own TCP connection.
 */

/** Well-known service names as advertised by the Directory. */
export const SERVICE_NAME = {
  DIRECTORY: 'Directory',
  STATE_MAP: 'StateMap',
  BEAT_INFO: 'BeatInfo',
  FILE_TRANSFER: 'FileTransfer',
  BROADCAST: 'Broadcast',
  TIME_SYNC: 'TimeSynchronization',
} as const;

export type ServiceName = (typeof SERVICE_NAME)[keyof typeof SERVICE_NAME];

/** Timeout for service connections (ms). */
export const SERVICE_TIMEOUT_MS = 8000;

/** Magic markers for services that use them. */
export const SERVICE_MAGIC = {
  STATE_MAP: new Uint8Array([0x73, 0x6d, 0x61, 0x61]), // "smaa"
  FILE_TRANSFER: new Uint8Array([0x66, 0x6c, 0x74, 0x78]), // "fltx"
} as const;

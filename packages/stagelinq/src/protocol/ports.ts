/** UDP port used for StageLinQ device discovery. */
export const DISCOVERY_PORT = 51337;

/** Magic bytes at the start of every discovery message: ASCII `"airD"`. */
export const DISCOVERY_MAGIC = new Uint8Array([0x61, 0x69, 0x72, 0x44]);

/** Length of the discovery magic marker in bytes. */
export const DISCOVERY_MAGIC_LENGTH = 4;

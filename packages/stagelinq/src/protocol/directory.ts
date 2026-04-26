/**
 * Directory service message types.
 *
 * The Directory service is the first TCP connection established after discovery.
 * It negotiates which services are available and their ports. Unlike other
 * services, Directory has its own message framing based on a 4-byte message ID
 * prefix (not length-prefixed).
 *
 * Directory messages:
 *   - ServicesAnnouncement (0x0): lists available services and their ports
 *   - TimeStamp (0x1): periodic keepalive with device uptime
 *   - ServicesRequest (0x2): request a specific service
 */

import { DEVICE_ID_LENGTH, type DeviceId, readDeviceId, writeDeviceId } from './device-id.js';
import { ReadContext } from './read-context.js';
import { WriteContext } from './write-context.js';

/** Directory message type IDs. */
export const DIRECTORY_MSG = {
  SERVICES_ANNOUNCEMENT: 0x0,
  TIMESTAMP: 0x1,
  SERVICES_REQUEST: 0x2,
} as const;

/** A single service entry from a ServicesAnnouncement. */
export interface ServiceEntry {
  readonly name: string;
  readonly port: number;
}

/** Parsed ServicesAnnouncement message. */
export interface ServicesAnnouncement {
  readonly type: typeof DIRECTORY_MSG.SERVICES_ANNOUNCEMENT;
  readonly deviceId: DeviceId;
  readonly services: readonly ServiceEntry[];
}

/** Parsed TimeStamp message. */
export interface TimeStampMessage {
  readonly type: typeof DIRECTORY_MSG.TIMESTAMP;
  readonly deviceId: DeviceId;
  /** Device uptime in nanoseconds. */
  readonly timeAlive: bigint;
}

/** Parsed ServicesRequest message. */
export interface ServicesRequest {
  readonly type: typeof DIRECTORY_MSG.SERVICES_REQUEST;
  readonly deviceId: DeviceId;
  readonly serviceName: string;
  readonly servicePort: number;
}

export type DirectoryMessage = ServicesAnnouncement | TimeStampMessage | ServicesRequest;

/**
 * Parse a Directory message from a TCP payload.
 * The payload starts with a 4-byte message ID, followed by a 16-byte DeviceId,
 * then message-specific data.
 *
 * Returns `null` if the payload is malformed.
 */
export function parseDirectoryMessage(payload: Uint8Array): DirectoryMessage | null {
  if (payload.length < 4 + DEVICE_ID_LENGTH) return null;

  try {
    const ctx = new ReadContext(payload);
    const messageId = ctx.readUInt32();
    const deviceId = readDeviceId(ctx);

    switch (messageId) {
      case DIRECTORY_MSG.SERVICES_ANNOUNCEMENT: {
        const services: ServiceEntry[] = [];
        // Remaining data is pairs of (NetworkString name, u16 port).
        while (ctx.remaining() > 0) {
          if (!ctx.hasBytes(4)) break; // Need at least string length prefix
          const name = ctx.readNetworkString();
          if (!ctx.hasBytes(2)) break;
          const port = ctx.readUInt16();
          services.push({ name, port });
        }
        return { type: DIRECTORY_MSG.SERVICES_ANNOUNCEMENT, deviceId, services };
      }

      case DIRECTORY_MSG.TIMESTAMP: {
        // 16 bytes padding/reserved, then 8 bytes timeAlive (nanoseconds).
        if (!ctx.hasBytes(16 + 8)) return null;
        ctx.skip(16);
        const timeAlive = ctx.readUInt64();
        return { type: DIRECTORY_MSG.TIMESTAMP, deviceId, timeAlive };
      }

      case DIRECTORY_MSG.SERVICES_REQUEST: {
        const serviceName = ctx.readNetworkString();
        if (!ctx.hasBytes(2)) return null;
        const servicePort = ctx.readUInt16();
        return { type: DIRECTORY_MSG.SERVICES_REQUEST, deviceId, serviceName, servicePort };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Build a ServicesRequest message to request a specific service from a device.
 */
export function buildServicesRequest(
  deviceId: DeviceId,
  serviceName: string,
  servicePort: number,
): Uint8Array {
  const ctx = new WriteContext();
  ctx.writeUInt32(DIRECTORY_MSG.SERVICES_REQUEST);
  writeDeviceId(ctx, deviceId);
  ctx.writeNetworkString(serviceName);
  ctx.writeUInt16(servicePort);
  return ctx.finish();
}

/**
 * Build the initial service-connection handshake message. This is the first
 * message sent on a new TCP connection to a service (not Directory itself).
 *
 *   [4B messageId: 0x0]
 *   [16B deviceId]
 *   [NetworkString serviceName]
 *   [2B reserved: 0x0]
 */
export function buildServiceHandshake(deviceId: DeviceId, serviceName: string): Uint8Array {
  const ctx = new WriteContext();
  ctx.writeUInt32(0x0);
  writeDeviceId(ctx, deviceId);
  ctx.writeNetworkString(serviceName);
  ctx.writeUInt16(0);
  return ctx.finish();
}

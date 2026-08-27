/**
 * Server-sent events for live message delivery to browsers and tools.
 *
 * Each frame carries the message id as the event id, so a reconnecting client
 * sends `Last-Event-ID` and the server replays from storage. A subscriber that
 * misses messages while disconnected therefore recovers them without a separate
 * catch-up request.
 */

import type { Message } from "./types";
import type { HerdrTopologySnapshot } from "./types";

export interface ReceiptUpdate {
  channel: string;
  handle: string;
  cursorMessageId: number;
}

type ReceiptPermission = (channel: string) => boolean;

const encoder = new TextEncoder();

export function frameFor(message: Message): Uint8Array {
  const data = JSON.stringify(message);
  return encoder.encode(`id: ${message.id}\ndata: ${data}\n\n`);
}

export function frameForTopology(snapshot: HerdrTopologySnapshot): Uint8Array {
  const data = JSON.stringify(snapshot);
  return encoder.encode(`event: topology\ndata: ${data}\n\n`);
}

export function frameForReceipt(update: ReceiptUpdate): Uint8Array {
  const data = JSON.stringify(update);
  return encoder.encode(`event: receipt\ndata: ${data}\n\n`);
}

/** Keeps the connection and any intermediary from treating a quiet hub as dead. */
function keepAliveFrame(): Uint8Array {
  return encoder.encode(`: keep-alive\n\n`);
}

export class Broadcaster {
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly receiptPermissions = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    ReceiptPermission
  >();

  get size(): number {
    return this.subscribers.size;
  }

  add(
    controller: ReadableStreamDefaultController<Uint8Array>,
    receiptPermission?: ReceiptPermission,
  ): void {
    this.subscribers.add(controller);
    if (receiptPermission === undefined) this.receiptPermissions.delete(controller);
    else this.receiptPermissions.set(controller, receiptPermission);
  }

  remove(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.subscribers.delete(controller);
    this.receiptPermissions.delete(controller);
  }

  /**
   * A subscriber whose stream has already closed throws on enqueue. That is a
   * disconnect, not a failure of the send, so it drops out quietly.
   */
  private send(frame: Uint8Array): void {
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(frame);
      } catch {
        this.remove(controller);
      }
    }
  }

  publish(message: Message): void {
    this.send(frameFor(message));
  }

  publishReceipt(update: ReceiptUpdate): void {
    const frame = frameForReceipt(update);
    for (const controller of this.subscribers) {
      const permission = this.receiptPermissions.get(controller);
      if (permission === undefined || !permission(update.channel)) continue;
      try {
        controller.enqueue(frame);
      } catch {
        this.remove(controller);
      }
    }
  }

  keepAlive(): void {
    this.send(keepAliveFrame());
  }

  closeAll(): void {
    for (const controller of this.subscribers) {
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    }
    this.subscribers.clear();
    this.receiptPermissions.clear();
  }
}

/** Separate subscriber set for the live herdr topology stream. */
export class TopologyBroadcaster {
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  get size(): number {
    return this.subscribers.size;
  }

  add(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.subscribers.add(controller);
  }

  remove(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.subscribers.delete(controller);
  }

  private send(frame: Uint8Array): void {
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(frame);
      } catch {
        this.subscribers.delete(controller);
      }
    }
  }

  publish(snapshot: HerdrTopologySnapshot): void {
    this.send(frameForTopology(snapshot));
  }

  keepAlive(): void {
    this.send(encoder.encode(": keep-alive\n\n"));
  }

  closeAll(): void {
    for (const controller of this.subscribers) {
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    }
    this.subscribers.clear();
  }
}

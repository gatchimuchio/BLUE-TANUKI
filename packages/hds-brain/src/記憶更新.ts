import {
  MTransactionStore,
  type JMemoryApprovalReader,
  type MemoryStoreSnapshot,
  type MemoryUpdateResult,
} from "./保存取引.js";
import type { MemoryUpdateReceiptV1 } from "@blue-tanuki/protocol";

/**
 * Internal M update API. It accepts only a parsed-content candidate and a
 * read-only J approval lookup; it is intentionally absent from the package
 * barrel until a real J producer and recovery path are implemented.
 */
export class MemoryUpdateLedger {
  private readonly store: MTransactionStore;
  private readonly jApprovalReader: JMemoryApprovalReader;

  constructor(options: {
    readonly private_state_root: string;
    readonly database_path: string;
    readonly j_approval_reader: JMemoryApprovalReader;
    readonly now?: () => Date;
  }) {
    this.store = new MTransactionStore({
      private_state_root: options.private_state_root,
      database_path: options.database_path,
      now: options.now,
    });
    this.jApprovalReader = options.j_approval_reader;
  }

  apply(input: unknown): MemoryUpdateResult {
    return this.store.applyApprovedMemoryCommit(input, this.jApprovalReader);
  }

  snapshot(): MemoryStoreSnapshot | null {
    return this.store.readSnapshot();
  }

  receipt(updateId: string): MemoryUpdateReceiptV1 | null {
    return this.store.readReceipt(updateId);
  }

  verify(): boolean {
    return this.store.verify();
  }

  close(): void {
    this.store.close();
  }
}

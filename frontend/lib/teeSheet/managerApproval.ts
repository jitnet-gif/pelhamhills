/**
 * 매니저 승인(0024). 환불·레인체크·선수 삭제·결제 취소는 서버가 PT428 로 거절하고, 메시지 끝에
 * `[approval:<action>:<ref>]` 를 붙인다. 여기서 그 거절을 잡아 PIN 창(`ManagerApprovalHost`)을 띄우고,
 * 매니저가 승인하면 같은 요청을 한 번 더 보낸다. 그래서 부르는 쪽(티 시트·Reports·계산대)은 고칠 것이 없다.
 *
 * 이 파일은 `staffRpc` 를 import 하지 않는다 — staffRpc 가 이 파일을 쓰기 때문이다(순환을 피한다).
 */

import { ApiError } from "./api";

export type ApprovalRequest = {
  action: string;
  ref: string;
  /** 꼬리표를 뗀 서버 메시지("A manager must approve this refund."). */
  message: string;
};

const TAG = /\s*\[approval:([a-z_]+):([^\]]+)\]\s*$/;

/** 매니저 승인이 필요해서 거절된 것이면 그 요청, 아니면 null. */
export function approvalNeeded(error: unknown): ApprovalRequest | null {
  if (!(error instanceof ApiError) || error.status !== 428) return null;
  const match = TAG.exec(error.message);
  if (!match) return null;
  return { action: match[1], ref: match[2], message: error.message.replace(TAG, "") };
}

type Prompt = (request: ApprovalRequest) => Promise<boolean>;

let prompt: Prompt | null = null;
// 같은 일·같은 대상을 동시에 두 번 물으면(예: 카드 두 장 환불) PIN 창은 한 번만 띄운다.
const pending = new Map<string, Promise<boolean>>();

/** PIN 창을 단다. 화면에 하나만 있다(`ManagerApprovalHost`). 뗄 때 쓰는 함수를 돌려준다. */
export function setApprovalPrompt(next: Prompt): () => void {
  prompt = next;
  return () => {
    if (prompt === next) prompt = null;
  };
}

function ask(request: ApprovalRequest): Promise<boolean> {
  const key = `${request.action}:${request.ref}`;
  const waiting = pending.get(key);
  if (waiting) return waiting;
  const asking = (prompt ? prompt(request) : Promise.resolve(false)).finally(() => pending.delete(key));
  pending.set(key, asking);
  return asking;
}

/** `run` 이 매니저 승인으로 막히면 PIN 을 받고 한 번 더 부른다. 매니저가 취소하면 428 로 끝난다. */
export async function withManagerApproval<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const request = approvalNeeded(error);
    if (!request) throw error;
    if (!(await ask(request))) throw new ApiError(428, `${request.message} Cancelled.`);
    return run();
  }
}

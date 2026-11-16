export const MAX_API_BASE = 'https://platform-api2.max.ru';
const MAX_TEXT_LENGTH = 4000;

function safeId(value) {
  const id = String(value ?? '').trim();
  return /^\d{1,24}$/.test(id) ? id : null;
}

function notificationText(item) {
  const shortId = String(item?.id ?? '').slice(0, 8);
  if (!/^[a-zA-Z0-9_-]{4,8}$/.test(shortId)) throw new TypeError('A valid request id is required');
  const model = String(item?.model ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  const lines = [`Новая заявка AVTOY KOREA №${shortId}`];
  if (model) lines.push(`Автомобиль: ${model}`);
  lines.push('Откройте защищённую операторскую панель для просмотра контактов и ответа.');
  const text = lines.join('\n');
  if (text.length > MAX_TEXT_LENGTH) throw new RangeError('MAX message exceeds the documented text limit');
  return text;
}

/**
 * MAX sender for the single configured internal operator group.
 * It intentionally never accepts a destination from the request payload.
 */
export function createMaxAdapter({
  token,
  operatorChatId,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  clock = () => Date.now(),
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  minIntervalMs = 550
} = {}) {
  const chatId = safeId(operatorChatId);
  const accessToken = String(token ?? '').trim();
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 500 || minIntervalMs > 10_000) {
    throw new TypeError('minIntervalMs must be between 500 and 10000');
  }

  // MAX allows at most two messages per second per chat. Serialize every
  // outbound path through one queue and keep a 50 ms safety margin.
  let sendChain = Promise.resolve();
  let nextSendAt = 0;
  function queueSend(operation) {
    const current = sendChain.then(async () => {
      const waitMs = Math.max(0, nextSendAt - clock());
      if (waitMs > 0) await sleepImpl(waitMs);
      nextSendAt = clock() + minIntervalMs;
      return operation();
    });
    sendChain = current.then(() => undefined, () => undefined);
    return current;
  }

  function retryAfterMs(response) {
    const raw = response?.headers?.get?.('retry-after');
    if (!raw) return undefined;
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? Math.ceil(seconds * 1000)
      : Date.parse(raw) - clock();
    return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 6 * 60 * 60 * 1000) : undefined;
  }

  async function sendText(text) {
    if (!accessToken || !chatId) return { ok:false, retryable:false, reason:'max_not_configured' };
    const safeText = String(text ?? '').replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, ' ').trim();
    if (!safeText || safeText.length > MAX_TEXT_LENGTH) return { ok:false, retryable:false, reason:'max_message_invalid' };
    return queueSend(async () => {
      try {
        const response = await fetchImpl(`${MAX_API_BASE}/messages?chat_id=${chatId}`, {
          method:'POST',
          headers:{ Authorization:accessToken, 'content-type':'application/json' },
          body:JSON.stringify({ text:safeText, notify:true }),
          signal:AbortSignal.timeout(timeoutMs)
        });
        const body = await response.json().catch(() => ({}));
        const rejected = body?.success === false;
        if (response.ok && !rejected) return { ok:true, retryable:false, receiptId:`max:${chatId}` };
        const status = Number(response.status || 0);
        const delay = status === 429 ? retryAfterMs(response) : undefined;
        return {
          ok:false,
          retryable:status === 408 || status === 425 || status === 429 || status >= 500,
          reason:status === 429 ? 'max_rate_limited' : status >= 500 ? 'max_server_error' : 'max_request_rejected',
          ...(delay ? { retryAfterMs:delay } : {})
        };
      } catch {
        return { ok:false, retryable:true, reason:'max_network_error' };
      }
    });
  }

  return Object.freeze({
    configured: Boolean(accessToken && chatId),
    async sendOperatorMessage(text) { return sendText(text); },
    async sendOperatorNotification(item) {
      if (!accessToken) return { ok: false, retryable: false, reason: 'max_not_configured' };
      if (!chatId) return { ok: false, retryable: false, reason: 'max_operator_chat_not_configured' };

      let text;
      try {
        text = notificationText(item);
      } catch (error) {
        return { ok: false, retryable: false, reason: error instanceof RangeError ? 'max_payload_invalid' : 'max_request_invalid' };
      }
      return sendText(text);
    }
  });
}

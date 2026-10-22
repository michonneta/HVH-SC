// Giải mã data.enc.json (AES-256-GCM, khóa từ PBKDF2-SHA256) và giải nén gzip ngay trên trình duyệt.

const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function decryptPayload(envelope, password) {
  if (envelope?.v !== 1 || envelope.alg !== 'AES-256-GCM') {
    throw new Error('Định dạng dữ liệu không được hỗ trợ.');
  }
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(envelope.salt), iterations: envelope.iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  let compressed;
  try {
    compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.data));
  } catch {
    const err = new Error('Sai mật khẩu.');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

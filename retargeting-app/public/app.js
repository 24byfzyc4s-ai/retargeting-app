function getSessionId() {
  return localStorage.getItem("sessionId");
}

async function ensureSession() {
  let sid = getSessionId();
  if (!sid) {
    const r = await fetch("/api/session/start", { method: "POST" });
    const data = await r.json();
    sid = data.sessionId;
    localStorage.setItem("sessionId", sid);
  }
  return sid;
}

async function apiPost(url, body) {
  const sid = await ensureSession();
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": sid
    },
    body: JSON.stringify(body ?? {})
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function trackFirstEvent(eventName) {
  return apiPost("/api/track/first-event", { event: eventName });
}

window.RR = {
  ensureSession,
  apiPost,
  trackFirstEvent
};
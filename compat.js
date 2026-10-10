"use strict";
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const nativeFetch = (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(55000) });
function readData() { return context.getStore().data; }
function writeData(data) { context.getStore().data = data; context.getStore().dirty = true; }
function readConfig() { return context.getStore().config; }
function createTranscriptionCredential() { return context.getStore().credential(); }
function normalizeBaseUrl(value) {
  const normalized = String(value || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) {
    throw new Error("Use an HTTPS API URL (HTTP is allowed only for localhost).");
  }
  return parsed.toString().replace(/\/$/, "");
}
function normalizeProvider(value, baseUrl) {
  const provider = String(value || "auto").trim().toLowerCase();
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("generativelanguage.googleapis.com")) return /\/openai(?:\/|$)/i.test(parsed.pathname) ? "openai" : "gemini";
    if (host.includes("anthropic.com")) return "anthropic";
  } catch (_) {}
  if (["openai", "anthropic", "gemini"].includes(provider)) return provider;
  return "openai";
}
function normalizeTranscriptionProvider(value) {
  const provider = String(value || "speechmatics").trim().toLowerCase();
  return provider === "deepgram" ? "deepgram" : "speechmatics";
}
function normalizeDeepgramModel(value) {
  const model = String(value || "nova-3").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(model)) throw new Error("Enter a valid Deepgram model name.");
  return model;
}
function geminiModelsUrl(baseUrl, apiKey) {
  let base = String(baseUrl).replace(/\/+$/, "").replace(/\/models$/i, "");
  return base + "/models?key=" + encodeURIComponent(apiKey);
}
function geminiGenerateUrl(baseUrl, model, apiKey) {
  let base = String(baseUrl).replace(/\/+$/, "");
  if (/:generateContent$/i.test(base)) return base + "?key=" + encodeURIComponent(apiKey);
  base = base.replace(/\/models$/i, "");
  return base + "/models/" + encodeURIComponent(String(model).replace(/^models\//, "")) + ":generateContent?key=" + encodeURIComponent(apiKey);
}
function normalizeAuthMode(value, provider, baseUrl) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (["bearer", "api-key"].includes(mode)) return mode;
  if (provider !== "anthropic") return "bearer";
  try {
    if (["127.0.0.1", "localhost", "::1"].includes(new URL(baseUrl).hostname)) return "bearer";
  } catch (_) {}
  return "api-key";
}
function providerHeaders(config) {
  if (config.provider === "anthropic") {
    const auth = config.authMode === "bearer" ? { authorization: "Bearer " + config.apiKey } : { "x-api-key": config.apiKey };
    return { ...auth, "anthropic-version": "2023-06-01" };
  }
  return { authorization: "Bearer " + config.apiKey };
}
function getInput(container, index) {
  const value = container && (container[index] !== undefined ? container[index] : container);
  return value && value.json !== undefined ? value.json : value || {};
}
function findSession(data, input) {
  const id = input.callSessionId || input.id;
  return data.sessions.find(item => item.id === id) || null;
}
function sessionDefaults(input) {
  const now = new Date().toISOString();
  return {
    ...input,
    id: randomUUID(),
    userId: context.getStore().user.id,
    createdAt: now,
    updatedAt: now,
    activatedAt: null,
    endedAt: null,
    expiresAt: null,
    deletedAt: null,
    isEndedOrExpired: false,
    isPlanSession: true,
    isFreeSession: false,
    mode: input.mode || "interview",
    metadata: input.metadata || {},
    aiMessagesClearedAt: null,
    transcriptClearedAt: null
  };
}
function updateSession(data, input, changes) {
  let item = findSession(data, input);
  if (!item && input.callSessionId) {
    item = sessionDefaults({ id: input.callSessionId });
    item.id = input.callSessionId;
    data.sessions.unshift(item);
  }
  if (!item) return null;
  Object.assign(item, changes, { id: item.id, userId: context.getStore().user.id, updatedAt: new Date().toISOString() });
  writeData(data);
  return item;
}
async function handleProcedure(name, input) {
  const data = readData();
  const localUser = {
    id: context.getStore().user.id, email: context.getStore().user.email, name: context.getStore().user.email, isAdmin: false,
    callCredits: context.getStore().dailyLimit, lifetimePurchasedAt: new Date(0).toISOString(),
    autoDetectEnabled: true, answerPreferencesOpenedAt: new Date(0).toISOString(),
    questionBankOptedOutAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString()
  };
  switch (name) {
    case "user.get": return localUser;
    case "user.getSessionForcedLogout": return false;
    case "user.markAnswerPreferencesOpened": return { ...localUser, answerPreferencesOpenedAt: new Date().toISOString() };
    case "user.update": return localUser;
    case "subscription.getState": return { isActive: true, tier: "full", status: "active", cancelAtPeriodEnd: false };
    case "configuration.getLanguages": return [{ value: "en", label: "English" }];
    case "configuration.getMixpanelConfig": return null;
    case "configuration.getVercelRegion": return "local";
    case "callSession.getMany": {
      const items = data.sessions.filter(item => !item.deletedAt);
      const limited = input.limit === "all" ? items : items.slice(0, Number(input.limit || 20));
      return { data: limited, nextCursor: null };
    }
    case "callSession.get": return findSession(data, input);
    case "callSession.create": {
      const item = sessionDefaults(input);
      data.sessions.unshift(item); writeData(data); return item;
    }
    case "callSession.delete": {
      const index = data.sessions.findIndex(item => item.id === (input.callSessionId || input.id));
      if (index >= 0) data.sessions.splice(index, 1);
      writeData(data);
      return true;
    }
    case "callSession.status.activate": return updateSession(data, input, { activatedAt: new Date().toISOString(), isEndedOrExpired: false });
    case "callSession.status.end":
    case "callSession.updateEnded": return updateSession(data, input, { endedAt: new Date().toISOString(), isEndedOrExpired: true });
    case "callSession.status.extendLimitedSession":
    case "callSession.status.restartPlanSession":
    case "callSession.updateLive":
    case "callSession.stampMeetingApp":
    case "callSession.takeOver": return updateSession(data, input, input) || true;
    case "callSession.metadata.update": {
      const item = findSession(data, input);
      return updateSession(data, input, { metadata: { ...(item && item.metadata || {}), ...(input.metadata || input) } }) || true;
    }
    case "callSession.ping": return { ok: true };
    case "callSession.reportLiveCallSessionError": return true;
    case "callSession.generateSpeechmaticsApiKey": return createTranscriptionCredential();
    case "callSession.transcription.get": return data.transcripts[input.callSessionId] || [];
    case "callSession.transcription.createMany": {
      const id = input.callSessionId;
      const entries = input.entries || input.transcriptions || input.data || [];
      data.transcripts[id] = [...(data.transcripts[id] || []), ...entries]; writeData(data); return true;
    }
    case "callSession.aiMessages.get": return data.messages[input.callSessionId] || [];
    case "callSession.scrapeJobPost.scrape": return { title: "", company: "", description: String(input.url || input.text || "") };
    case "callDocument.getMany": return { data: data.documents, nextCursor: null };
    case "resume.getMany": return { data: data.resumes, nextCursor: null };
    case "speakerEnrollment.list": return [];
    case "speakerEnrollment.attachToCallSession":
    case "speakerEnrollment.markStale":
    case "feedback.answerPostCall":
    case "feedback.rateResponse":
    case "feedback.recordCopied": return true;
    default: throw Object.assign(new Error("Unsupported operation"), { status: 400 });
  }
}

function superjson(value) {
  const dates = {};
  function visit(current, key) {
    if (typeof current === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(current)) dates[key] = ["Date"];
    else if (current && typeof current === "object") Object.keys(current).forEach(child => visit(current[child], key ? key + "." + child : child));
  }
  visit(value, "");
  const result = { json: value };
  if (Object.keys(dates).length) result.meta = { values: dates, v: 1 };
  return result;
}
function chatTrigger(body) {
  if (!body || typeof body !== "object") return {};
  if (body.trigger && typeof body.trigger === "object") return body.trigger;
  if (body.metadata && body.metadata.trigger && typeof body.metadata.trigger === "object") return body.metadata.trigger;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if (message.trigger && typeof message.trigger === "object") return message.trigger;
    if (message.metadata && message.metadata.trigger && typeof message.metadata.trigger === "object") return message.metadata.trigger;
  }
  return {};
}
function promptFromChat(body) {
  const trigger = chatTrigger(body);
  const direct = trigger.chatInput || trigger.input || body.prompt;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const triggerText = Array.isArray(trigger.parts)
    ? trigger.parts.filter(part => part && part.type === "text").map(part => part.text || "").filter(Boolean).join("\n")
    : "";
  if (triggerText.trim()) return triggerText.trim();
  const rows = body.pendingTranscriptEntries || [];
  const text = rows.map(row => row.transcript || row.text || row.content || "").filter(Boolean).join("\n");
  return text || "Give concise, useful help for the current session.";
}
function firstText(source, names) {
  if (!source || typeof source !== "object") return "";
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
function itemId(item) {
  return item && String(item.id || item.resumeId || item.documentId || item._id || "");
}
function libraryItemText(item) {
  if (!item || typeof item !== "object") return "";
  const title = firstText(item, ["title", "name", "fileName", "filename"]);
  const content = firstText(item, [
    "content", "text", "plainText", "parsedText", "extractedText", "markdown",
    "description", "body", "resumeText", "documentText"
  ]);
  const nested = firstText(item.data, ["content", "text", "plainText", "parsedText", "extractedText", "markdown", "body"]);
  const text = content || nested;
  return [title && "Title: " + title, text].filter(Boolean).join("\n");
}
function sessionContext(chatBody) {
  const data = readData();
  const trigger = chatTrigger(chatBody || {});
  const sessionId = chatBody.callSessionId || chatBody.sessionId || trigger.callSessionId || trigger.sessionId;
  const sessionItem = data.sessions.find(item => item.id === sessionId);
  if (!sessionItem) return "";
  const metadata = sessionItem.metadata && typeof sessionItem.metadata === "object" ? sessionItem.metadata : {};
  const value = name => sessionItem[name] !== undefined ? sessionItem[name] : metadata[name];
  const sections = [];
  const jobLines = [
    value("title") && "Company / session: " + value("title"),
    value("companyDomain") && "Company domain: " + value("companyDomain"),
    (value("jobDescription") || value("description") || value("roleDescription")) && "Job description: " + (value("jobDescription") || value("description") || value("roleDescription"))
  ].filter(Boolean);
  if (jobLines.length) sections.push("JOB AND SESSION DETAILS\n" + jobLines.join("\n"));

  const resumeId = value("resumeId") || value("selectedResumeId");
  const resume = resumeId ? data.resumes.find(item => itemId(item) === String(resumeId)) : (data.resumes.length === 1 ? data.resumes[0] : null);
  const resumeText = libraryItemText(resume);
  if (resumeText) sections.push("SELECTED RESUME\n" + resumeText);

  const selected = value("selectedDocumentIds") || value("documentIds") || value("selectedDocuments");
  const selectedIds = Array.isArray(selected) ? selected.map(item => typeof item === "object" ? itemId(item) : String(item)) : [];
  const useAllDocuments = value("documentSelectionMode") === "all";
  const documents = useAllDocuments
    ? data.documents
    : data.documents.filter(item => selectedIds.includes(itemId(item)));
  const documentText = documents.map(libraryItemText).filter(Boolean);
  if (documentText.length) sections.push("SELECTED DOCUMENTS\n" + documentText.map((text, index) => "Document " + (index + 1) + ":\n" + text).join("\n\n"));

  const instructions = firstText(sessionItem, ["extraContext", "instructions", "customInstructions"])
    || firstText(metadata, ["extraContext", "instructions", "customInstructions"]);
  if (instructions) sections.push("USER INSTRUCTIONS\n" + instructions);

  const preferenceValues = {
    "Response length": value("responseLength"),
    "Response format": value("responseFormat"),
    "Response tone": value("responseTone"),
    "Use STAR method": value("useStarMethod"),
    "Use natural filler words": value("useFillerWords")
  };
  const preferences = Object.entries(preferenceValues)
    .filter(([, preference]) => preference !== undefined && preference !== null && preference !== "")
    .map(([label, preference]) => label + ": " + String(preference));
  if (preferences.length) sections.push("ANSWER PREFERENCES\n" + preferences.join("\n"));
  return sections.join("\n\n");
}
function systemPrompt(chatBody) {
  const context = sessionContext(chatBody || {});
  const base = "You are a concise real-time interview and meeting assistant. Answer the current spoken, typed, or on-screen question directly and accurately. Ground personal-experience answers in the supplied resume, tailor role answers to the job description, and use selected documents when relevant. If the question is outside those materials, answer it from reliable general knowledge. Never invent the user's personal experience, employers, skills, or achievements.";
  return context ? base + "\n\nSESSION CONTEXT\n" + context : base;
}
function screenshotAttachments(chatBody) {
  const body = chatBody || {};
  const trigger = chatTrigger(body);
  const values = [];
  const appendValue = value => {
    if (typeof value === "string") values.push(value);
    else if (value && typeof value === "object") {
      if (typeof value.url === "string") values.push(value.url);
      if (value.image_url && typeof value.image_url.url === "string") values.push(value.image_url.url);
    }
  };
  const appendList = value => { if (Array.isArray(value)) value.forEach(appendValue); };
  [body.screenshots, trigger.screenshots, body.images, trigger.images, trigger.parts].forEach(appendList);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    appendList(message.parts);
    appendList(message.content);
    if (message.metadata && message.metadata.trigger) appendList(message.metadata.trigger.parts);
  }
  const attachments = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    const match = value.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (!match) continue;
    const mediaType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
    const data = match[2].replace(/\s+/g, "");
    const bytes = Buffer.byteLength(data, "base64");
    totalBytes += bytes;
    if (attachments.length >= 10 || totalBytes > 16 * 1024 * 1024) throw new Error("Screenshots exceed the local attachment limit.");
    attachments.push({ mediaType, data, dataUrl: "data:" + mediaType + ";base64," + data });
  }
  return attachments;
}
function geminiDocumentParts(chatBody) {
  const data = readData();
  const sessionItem = data.sessions.find(item => item.id === chatBody.callSessionId);
  if (!sessionItem) return [];
  const metadata = sessionItem.metadata && typeof sessionItem.metadata === "object" ? sessionItem.metadata : {};
  const value = name => sessionItem[name] !== undefined ? sessionItem[name] : metadata[name];
  const items = [];
  const resumeId = value("resumeId");
  const resume = resumeId ? data.resumes.find(item => itemId(item) === String(resumeId)) : null;
  if (resume) items.push(resume);
  const selectedIds = Array.isArray(value("selectedDocumentIds")) ? value("selectedDocumentIds").map(String) : [];
  items.push(...(value("documentSelectionMode") === "all"
    ? data.documents
    : data.documents.filter(item => selectedIds.includes(itemId(item)))));
  const pdfs = items.filter(item => item.mimeType === "application/pdf" && item.rawBase64);
  const totalBytes = pdfs.reduce((sum, item) => sum + Buffer.byteLength(item.rawBase64, "base64"), 0);
  if (totalBytes > 48 * 1024 * 1024) throw new Error("Selected PDF files exceed 48 MB in total. Select fewer or smaller documents.");
  return pdfs.flatMap(item => [
    { text: "Attached local PDF: " + (item.fileName || item.title || "document") },
    { inlineData: { mimeType: "application/pdf", data: item.rawBase64 } }
  ]);
}
function apiError(parsed, status, fallback) {
  return parsed && parsed.error && (parsed.error.message || parsed.error.type) || parsed && parsed.message || fallback + " (" + status + ").";
}
async function fetchJson(url, options, fallback) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await nativeFetch(url, options);
      const raw = await response.text();
      let parsed = {}; try { parsed = JSON.parse(raw); } catch (_) {}
      if (!response.ok) {
        const error = Object.assign(new Error(apiError(parsed, response.status, fallback)), { status: response.status });
        if (![408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)) throw error;
        lastError = error;
      } else return parsed;
    } catch (error) {
      lastError = error;
      if (error.status && ![408, 409, 425, 429, 500, 502, 503, 504].includes(error.status)) throw error;
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Object.assign(new Error(lastError?.message || fallback + ". Please retry."), { status: lastError?.status || 503 });
}
async function requestCompletion(payloadConfig, chatBody) {
  if (!nativeFetch) throw new Error("Fetch is unavailable in this Electron version.");
  const config = payloadConfig || readConfig();
  if (!config.apiKey) throw new Error("Open API settings and save your API key first.");
  const screenshots = screenshotAttachments(chatBody || {});
  let prompt = promptFromChat(chatBody || {});
  if (screenshots.length && chatTrigger(chatBody).kind === "analyze-screen") {
    prompt = "Analyze the attached screenshot and answer the visible question or provide the requested help.\n\n" + prompt;
  }
  const system = systemPrompt(chatBody || {});
  if (config.provider === "anthropic") {
    const content = [
      ...screenshots.map(item => ({ type: "image", source: { type: "base64", media_type: item.mediaType, data: item.data } })),
      { type: "text", text: prompt }
    ];
    const parsed = await fetchJson(config.baseUrl + "/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...providerHeaders(config) },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content }]
      })
    }, "Anthropic request failed");
    return Array.isArray(parsed.content) ? parsed.content.filter(item => item && item.type === "text").map(item => item.text).join("") : "";
  }
  if (config.provider === "gemini") {
    const model = String(config.model).replace(/^models\//, "");
    const documentParts = geminiDocumentParts(chatBody || {});
    const parsed = await fetchJson(geminiGenerateUrl(config.baseUrl, model, config.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [...documentParts, ...screenshots.map(item => ({ inlineData: { mimeType: item.mediaType, data: item.data } })), { text: prompt }] }]
      })
    }, "Gemini request failed");
    return (parsed.candidates || []).flatMap(item => item && item.content && item.content.parts || []).map(item => item.text || "").join("");
  }
  const parsed = await fetchJson(config.baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.apiKey },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: screenshots.length ? [
          { type: "text", text: prompt },
          ...screenshots.map(item => ({ type: "image_url", image_url: { url: item.dataUrl } }))
        ] : prompt }
      ]
    })
  }, "OpenAI-compatible request failed");
  return parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content || "";
}
function startSse(response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "access-control-allow-origin": "*", "x-accel-buffering": "no", "x-vercel-ai-ui-message-stream": "v1" });
  const id = randomUUID();
  [{ type: "start", messageId: id }, { type: "start-step" }, { type: "text-start", id: "text-1" }]
    .forEach(chunk => response.write("data: " + JSON.stringify(chunk) + "\n\n"));
  return id;
}
function writeSse(response, content, id) {
  id ||= startSse(response);
  const chunks = [
    { type: "text-delta", id: "text-1", delta: content }, { type: "text-end", id: "text-1" },
    { type: "finish-step" }, { type: "finish", finishReason: "stop" }
  ];
  chunks.forEach(chunk => response.write("data: " + JSON.stringify(chunk) + "\n\n"));
  response.end("data: [DONE]\n\n");
}
function writeSseError(response, error, id) {
  id ||= startSse(response);
  const message = error?.message || "The answer service did not respond. Please retry.";
  [{ type: "error", errorText: message }, { type: "text-end", id: "text-1" }, { type: "finish-step" }, { type: "finish", finishReason: "error" }]
    .forEach(chunk => response.write("data: " + JSON.stringify(chunk) + "\n\n"));
  response.end("data: [DONE]\n\n");
}

module.exports = { context, getInput, handleProcedure, superjson, requestCompletion, startSse, writeSse, writeSseError, promptFromChat, sessionContext, systemPrompt };

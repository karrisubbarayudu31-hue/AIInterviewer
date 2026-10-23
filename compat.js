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
let geminiKeyIndex = 0;
function parseApiKeys(raw) {
  if (Array.isArray(raw)) return raw.flatMap(parseApiKeys);
  return String(raw || '').split(/[,;|\s]+/).map(s => s.trim()).filter(Boolean);
}
function getOrderedApiKeys(rawKey) {
  const keys = parseApiKeys(rawKey);
  if (keys.length <= 1) return keys;
  const start = geminiKeyIndex % keys.length;
  geminiKeyIndex = (geminiKeyIndex + 1) % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}
function geminiModelsUrl(baseUrl, apiKey) {
  let base = String(baseUrl).replace(/\/+$/, "").replace(/\/models$/i, "");
  const firstKey = parseApiKeys(apiKey)[0] || '';
  return base + "/models?key=" + encodeURIComponent(firstKey);
}
function geminiGenerateUrl(baseUrl, model, apiKey) {
  let base = String(baseUrl).replace(/\/+$/, "");
  const firstKey = parseApiKeys(apiKey)[0] || '';
  if (/:generateContent$/i.test(base)) return base + "?key=" + encodeURIComponent(firstKey);
  base = base.replace(/\/models$/i, "");
  return base + "/models/" + encodeURIComponent(String(model).replace(/^models\//, "")) + ":generateContent?key=" + encodeURIComponent(firstKey);
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
      const sessionId = input.callSessionId || input.id;
      const index = data.sessions.findIndex(item => item.id === sessionId);
      if (index >= 0) data.sessions.splice(index, 1);
      if (data.conversations) delete data.conversations[sessionId];
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
    case "callSession.searchCompanies": {
      const query = String(input?.query || "").trim().slice(0, 120);
      if (!query) return [];
      const companies = [
        ["Accenture", "accenture.com"], ["Adobe", "adobe.com"], ["Amazon", "amazon.com"],
        ["Apple", "apple.com"], ["Capgemini", "capgemini.com"], ["Cognizant", "cognizant.com"],
        ["Deloitte", "deloitte.com"], ["Google", "google.com"], ["HCLTech", "hcltech.com"],
        ["IBM", "ibm.com"], ["Infosys", "infosys.com"], ["Meta", "meta.com"],
        ["Microsoft", "microsoft.com"], ["Oracle", "oracle.com"], ["Salesforce", "salesforce.com"],
        ["Tata Consultancy Services", "tcs.com"], ["Tech Mahindra", "techmahindra.com"],
        ["Wipro", "wipro.com"]
      ].map(([companyName, domain]) => ({ name: companyName, domain }));
      const lower = query.toLowerCase();
      const matches = companies.filter(company => company.name.toLowerCase().includes(lower) || company.domain.includes(lower)).slice(0, 8);
      if (!matches.some(company => company.name.toLowerCase() === lower)) matches.unshift({ name: query, domain: "" });
      return matches.slice(0, 8);
    }
    case "callSession.scrapeJobPost.scrape": {
      const raw = String(input?.url || input?.text || "").trim();
      let jobUrl;
      try { jobUrl = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); }
      catch { throw Object.assign(new Error("Enter a valid job link."), { status: 400 }); }
      if (jobUrl.protocol !== "https:" || jobUrl.username || jobUrl.password) {
        throw Object.assign(new Error("Enter a valid HTTPS job link."), { status: 400 });
      }
      const host = jobUrl.hostname.replace(/^www\./i, "");
      const companyName = host.split(".")[0].replace(/[-_]+/g, " ").replace(/\b\w/g, character => character.toUpperCase());
      return { companyName, jobDescription: "Job post: " + jobUrl.href };
    }
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
function chatSessionId(body) {
  const trigger = chatTrigger(body || {});
  return String(body?.callSessionId || body?.sessionId || trigger.callSessionId || trigger.sessionId || "").trim();
}
function conversationHistory(chatBody, limit = 8) {
  const data = readData();
  const sessionId = chatSessionId(chatBody);
  if (!sessionId || !data.conversations || !Array.isArray(data.conversations[sessionId])) return [];
  return data.conversations[sessionId]
    .filter(turn => turn && ["user", "assistant"].includes(turn.role) && typeof turn.content === "string" && turn.content.trim())
    .slice(-limit)
    .map(turn => ({ role: turn.role, content: turn.content.slice(0, 8000) }));
}
function rememberConversation(chatBody, question, answer) {
  const data = readData();
  const sessionId = chatSessionId(chatBody);
  if (!sessionId || !question || !answer) return false;
  data.conversations ||= {};
  const turns = Array.isArray(data.conversations[sessionId]) ? data.conversations[sessionId] : [];
  turns.push(
    { role: "user", content: String(question).slice(0, 8000), createdAt: new Date().toISOString() },
    { role: "assistant", content: String(answer).slice(0, 12000), createdAt: new Date().toISOString() }
  );
  data.conversations[sessionId] = turns.slice(-12);
  writeData(data);
  return true;
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
function answerStyleInstructions(chatBody) {
  const data = readData();
  const trigger = chatTrigger(chatBody || {});
  const sessionId = chatBody.callSessionId || chatBody.sessionId || trigger.callSessionId || trigger.sessionId;
  const sessionItem = data.sessions.find(item => item.id === sessionId) || {};
  const metadata = sessionItem.metadata && typeof sessionItem.metadata === "object" ? sessionItem.metadata : {};
  const value = (name, fallback) => sessionItem[name] !== undefined ? sessionItem[name] : metadata[name] !== undefined ? metadata[name] : fallback;
  const length = value("responseLength", "balanced");
  const format = value("responseFormat", "balanced");
  const tone = value("responseTone", "simple");
  const allowedFocuses = new Set(["auto", "c", "cpp", "java", "ai-ml", "cloud-devops", "system-design", "data-sql", "frontend-js", "cybersecurity"]);
  const focus = allowedFocuses.has(chatBody.interviewFocus) ? chatBody.interviewFocus : "auto";
  const company = [value("title", ""), value("companyDomain", ""), value("companyName", "")].join(" ").toLowerCase();
  const focusRules = {
    auto: "Interview focus: infer the primary technology from the question, job description, resume, and recent conversation. Do not force an unrelated language or framework.",
    c: "Interview focus: C. Emphasize pointers and ownership, memory layout and lifetime, undefined behavior, arrays and strings, structs, compilation/linking, portability, concurrency, and performance. For code, use valid C, trace memory carefully, cover failure paths, and state complexity.",
    cpp: "Interview focus: C++. Emphasize RAII, value/reference semantics, object lifetime, smart pointers, STL choices, const-correctness, copy/move behavior, templates, exceptions, concurrency, and performance. Prefer modern, idiomatic C++ and explain ownership and complexity.",
    java: "Interview focus: Java. Explain JVM behavior where relevant, collections and their complexity, generics, immutability, exceptions, concurrency and the memory model, garbage collection, testing, and common backend/Spring trade-offs. Give clean, compilable Java and discuss production concerns.",
    "ai-ml": "Interview focus: AI and machine learning. Structure answers around problem framing, data and labels, baselines, features or representations, model choice, training and validation, metrics, leakage and bias, error analysis, deployment, latency/cost, monitoring and drift, safety, and iteration. For generative AI include prompting/RAG/fine-tuning choices, retrieval quality, groundedness, evaluation, guardrails, and human review.",
    "cloud-devops": "Interview focus: cloud and DevOps. Start from workload and SLOs, then cover architecture, networking, identity and least privilege, data/storage, scaling, high availability and disaster recovery, deployment and rollback, infrastructure as code, observability, incident response, security, compliance, and cost. Name a vendor service only when it clarifies the design and mention a portable alternative.",
    "system-design": "Interview focus: system design. Clarify functional and non-functional requirements, estimate scale, define APIs and data model, show components and data flow, then address consistency, partitioning, caching, queues, failure modes, security, observability, cost, and explicit trade-offs. Evolve from a simple design to the required scale.",
    "data-sql": "Interview focus: data and SQL. Clarify grain and correctness, explain schema and joins, provide readable SQL, discuss indexes and query plans, transactions and isolation, null/duplicate handling, data quality, scale, and validation. For analytics connect the result to a decision and an appropriate metric.",
    "frontend-js": "Interview focus: frontend and JavaScript. Cover browser/runtime behavior, event loop and async work, state and data flow, component design, accessibility, performance, security, testing, compatibility, and user experience. Give clear JavaScript or TypeScript with edge cases and explain framework-specific choices only when relevant.",
    cybersecurity: "Interview focus: cybersecurity. State assets, trust boundaries, threat model and assumptions; prioritize risks by likelihood and impact; recommend layered controls, least privilege, secure defaults, validation, secrets management, logging and detection, response, and verification. For vulnerabilities explain the root cause and safe remediation without inventing evidence."
  };
  const rules = [
    length === "concise"
      ? "Length: concise, normally 50-90 words unless the question requires code or a list."
      : length === "detailed"
        ? "Length: detailed, normally 250-400 words with explanation, examples, and supporting detail."
        : "Length: balanced, normally 140-220 words with enough context to answer confidently.",
    format === "paragraph"
      ? "Format: a complete natural spoken script in paragraphs, with no bullet list unless the question explicitly asks for one."
      : format === "bullets"
        ? "Format: short, clear bullet points that the user can express in their own words."
        : "Format: begin with a natural spoken answer, then add concise supporting bullet points.",
    tone === "formal"
      ? "Tone: precise and professional."
      : "Tone: simple, conversational language without unnecessary jargon."
  ];
  if (value("useStarMethod", false)) rules.push("For behavioral or experience questions, explicitly structure the answer as Situation, Task, Action, and Result.");
  if (value("useFillerWords", false) && format !== "bullets") rules.push("Use a few natural spoken transitions such as 'well' or 'for example', without overusing them.");
  rules.push(focusRules[focus]);
  if (/amazon|aws/.test(company)) rules.push("Company emphasis—Amazon/AWS: connect behavioral evidence to relevant Leadership Principles, use STAR, distinguish the candidate's own actions, and include truthful metrics. For technical choices explain customer impact, ownership, operational readiness, and trade-offs.");
  else if (/microsoft|azure/.test(company)) rules.push("Company emphasis—Microsoft/Azure: show collaborative problem solving, clarify assumptions, reason step by step, test the solution, discuss customer impact and trade-offs, and demonstrate learning from feedback.");
  else if (/google|alphabet/.test(company)) rules.push("Company emphasis—Google: make the reasoning explicit, clarify constraints, derive a correct and efficient solution, test edge cases, and discuss scalability, reliability, and collaboration. Avoid memorized answers without justification.");
  else if (/meta|facebook|instagram|whatsapp/.test(company)) rules.push("Company emphasis—Meta: communicate the approach while coding, produce working code efficiently, analyze complexity and follow-up optimizations, and connect design decisions to product impact and operation at scale.");
  else if (/oracle/.test(company)) rules.push("Company emphasis—Oracle: answer the question directly, show the individual contribution rather than vague team claims, support experience with facts or figures, and demonstrate structured technical problem solving and role-specific preparation.");
  else if (/apple/.test(company)) rules.push("Company emphasis—Apple: demonstrate technical depth, product quality, privacy and security awareness, careful trade-offs, and effective cross-functional collaboration while protecting confidential information.");
  else if (/netflix/.test(company)) rules.push("Company emphasis—Netflix: show sound judgment, ownership, candid communication, high-leverage decisions, and engineering for reliability, performance, and business impact.");
  rules.push("Lead with a direct, speakable answer in one or two sentences, then support it with the depth selected by the user. Write for live speech: short sentences, one idea at a time, concrete wording, and no dense wall of text.");
  rules.push("Infer the question type and use the matching interview structure. Technical knowledge: definition, how it works, when to use it, trade-offs, and a practical example. Coding or algorithms: clarify assumptions, explain the approach, give correct code or pseudocode when requested, state time and space complexity, and cover edge cases. System design: requirements and scale assumptions, architecture and data flow, APIs and data model, scaling and failure handling, security and observability, then explicit trade-offs. Troubleshooting: likely causes, a prioritized diagnostic sequence, the fix, validation, and prevention. Behavioral or project experience: use STAR and only facts supported by the resume or session context.");
  rules.push("For follow-up questions, use recent conversation context and answer the new point without restarting the entire explanation. If a necessary detail is missing, state a reasonable assumption briefly instead of stalling.");
  return rules.join("\n");
}
function systemPrompt(chatBody) {
  const context = sessionContext(chatBody || {});
  const style = answerStyleInstructions(chatBody || {});
  const base = "You are an expert real-time technical interview assistant. Produce an accurate answer the candidate can speak naturally, with enough technical depth to satisfy a senior interviewer. Answer the current spoken, typed, or on-screen question first; do not waste time with an introduction. Treat recent question-and-answer turns as one continuous conversation: resolve pronouns and follow-up phrases from that history, preserve relevant facts, and do not repeat earlier material unless it helps answer the new question. Ground personal-experience answers in the supplied resume, tailor role answers to the job description and company context, and use selected documents when relevant. If the question is outside those materials, answer it from reliable general knowledge. Distinguish facts, assumptions, and recommendations. Never invent the user's personal experience, employers, skills, metrics, or achievements. For ambiguous technical questions, state the most likely interpretation and proceed. Follow the requested length, format, and tone while preserving correctness, key trade-offs, and interview-ready clarity.";
  return base + "\n\nANSWER STYLE\n" + style + (context ? "\n\nSESSION CONTEXT\n" + context : "");
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
    prompt = "Inspect the attached screenshot carefully. Read the visible question, code, error, diagram, table, and answer choices before responding. Solve the exact on-screen task and explain the reasoning at an interview-ready level. For code, identify the language, defects, edge cases, corrected approach, and complexity when relevant. For multiple choice, name the selected option and justify it. Do not invent text that is not readable; if a critical region is unclear, say exactly what is unreadable and answer from the visible evidence.\n\n" + prompt;
  }
  const system = systemPrompt(chatBody || {});
  const history = conversationHistory(chatBody || {});
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
        messages: [...history, { role: "user", content }]
      })
    }, "Anthropic request failed");
    return Array.isArray(parsed.content) ? parsed.content.filter(item => item && item.type === "text").map(item => item.text).join("") : "";
  }
  if (config.provider === "gemini") {
    const model = String(config.model).replace(/^models\//, "");
    const documentParts = geminiDocumentParts(chatBody || {});
    const keys = getOrderedApiKeys(config.apiKey);
    let lastError;
    for (const key of keys) {
      try {
        const parsed = await fetchJson(geminiGenerateUrl(config.baseUrl, model, key), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [
              ...history.map(turn => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })),
              { role: "user", parts: [...documentParts, ...screenshots.map(item => ({ inlineData: { mimeType: item.mediaType, data: item.data } })), { text: prompt }] }
            ]
          })
        }, "Gemini request failed");
        return (parsed.candidates || []).flatMap(item => item && item.content && item.content.parts || []).map(item => item.text || "").join("");
      } catch (err) {
        lastError = err;
        if (keys.length > 1 && [408, 409, 425, 429, 500, 502, 503, 504].includes(err.status)) continue;
        throw err;
      }
    }
    throw lastError || new Error("All Gemini API keys failed.");
  }
  const parsed = await fetchJson(config.baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.apiKey },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: screenshots.length ? [
          { type: "text", text: prompt },
          ...screenshots.map(item => ({ type: "image_url", image_url: { url: item.dataUrl } }))
        ] : prompt }
      ]
    })
  }, "OpenAI-compatible request failed");
  return parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content || "";
}
async function requestCompletionStream(payloadConfig, chatBody, onDelta) {
  if (!nativeFetch) throw new Error("Fetch is unavailable in this Electron version.");
  const config = payloadConfig || readConfig();
  if (!config.apiKey) throw new Error("Open API settings and save your API key first.");
  const screenshots = screenshotAttachments(chatBody || {});
  let prompt = promptFromChat(chatBody || {});
  if (screenshots.length && chatTrigger(chatBody).kind === "analyze-screen") {
    prompt = "Inspect the attached screenshot carefully. Read the visible question, code, error, diagram, table, and answer choices before responding. Solve the exact on-screen task and explain the reasoning at an interview-ready level. For code, identify the language, defects, edge cases, corrected approach, and complexity when relevant. For multiple choice, name the selected option and justify it. Do not invent text that is not readable; if a critical region is unclear, say exactly what is unreadable and answer from the visible evidence.\n\n" + prompt;
  }
  const system = systemPrompt(chatBody || {});
  const history = conversationHistory(chatBody || {});
  let provider = config.provider;
  let url;
  let options;
  let response;
  let lastError;
  const keys = provider === "gemini" ? getOrderedApiKeys(config.apiKey) : [config.apiKey];

  for (const key of keys) {
    if (provider === "anthropic") {
      const content = [
        ...screenshots.map(item => ({ type: "image", source: { type: "base64", media_type: item.mediaType, data: item.data } })),
        { type: "text", text: prompt }
      ];
      url = config.baseUrl + "/messages";
      options = { method: "POST", headers: { "content-type": "application/json", ...providerHeaders({ ...config, apiKey: key }) }, body: JSON.stringify({ model: config.model, max_tokens: 2048, stream: true, system, messages: [...history, { role: "user", content }] }) };
    } else if (provider === "gemini") {
      const model = String(config.model).replace(/^models\//, "");
      const documentParts = geminiDocumentParts(chatBody || {});
      url = geminiGenerateUrl(config.baseUrl, model, key).replace(":generateContent?", ":streamGenerateContent?alt=sse&");
      options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [...history.map(turn => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })), { role: "user", parts: [...documentParts, ...screenshots.map(item => ({ inlineData: { mimeType: item.mediaType, data: item.data } })), { text: prompt }] }]
      }) };
    } else {
      url = config.baseUrl + "/chat/completions";
      options = { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ model: config.model, stream: true, messages: [
        { role: "system", content: system }, ...history,
        { role: "user", content: screenshots.length ? [{ type: "text", text: prompt }, ...screenshots.map(item => ({ type: "image_url", image_url: { url: item.dataUrl } }))] : prompt }
      ] }) };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await nativeFetch(url, options);
        if (response.ok) break;
        const raw = await response.text();
        let parsed = {}; try { parsed = JSON.parse(raw); } catch (_) {}
        lastError = Object.assign(new Error(apiError(parsed, response.status, "Model request failed")), { status: response.status });
        if (![408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
      } catch (error) {
        lastError = error;
        if (error.status && ![408, 409, 425, 429, 500, 502, 503, 504].includes(error.status)) break;
      }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (response && response.ok) break;
    if (keys.length > 1 && [408, 409, 425, 429, 500, 502, 503, 504].includes(lastError?.status)) {
      continue;
    }
  }
  if (!response?.ok) throw Object.assign(new Error(lastError?.message || "Model request failed. Please retry."), { status: lastError?.status || 503 });
  if (!response.body) throw new Error("The model returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  const accept = raw => {
    const value = raw.trim();
    if (!value || value === "[DONE]") return;
    let event; try { event = JSON.parse(value); } catch (_) { return; }
    const delta = provider === "anthropic"
      ? event?.delta?.text || ""
      : provider === "gemini"
        ? (event?.candidates || []).flatMap(item => item?.content?.parts || []).map(item => item.text || "").join("")
        : event?.choices?.[0]?.delta?.content || "";
    if (delta) { answer += delta; onDelta(delta); }
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop();
    for (const line of lines) if (line.startsWith("data:")) accept(line.slice(5));
    if (done) break;
  }
  if (buffer.startsWith("data:")) accept(buffer.slice(5));
  if (!answer.trim()) throw new Error("The model returned an empty response.");
  return answer;
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
  const chunks = [{ type: "text-delta", id: "text-1", delta: content }];
  chunks.forEach(chunk => response.write("data: " + JSON.stringify(chunk) + "\n\n"));
  finishSse(response, id);
}
function writeSseDelta(response, content) {
  if (content && !response.writableEnded) response.write("data: " + JSON.stringify({ type: "text-delta", id: "text-1", delta: content }) + "\n\n");
}
function finishSse(response) {
  const chunks = [
    { type: "text-end", id: "text-1" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" }
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

module.exports = { context, getInput, handleProcedure, superjson, requestCompletion, requestCompletionStream, startSse, writeSse, writeSseDelta, finishSse, writeSseError, promptFromChat, chatSessionId, conversationHistory, rememberConversation, sessionContext, answerStyleInstructions, systemPrompt };

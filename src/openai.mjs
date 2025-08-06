//Author: PublicAffairs
//Project: https://github.com/PublicAffairs/openai-gemini
//MIT License : https://github.com/PublicAffairs/openai-gemini/blob/main/LICENSE


import { Buffer } from "node:buffer";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      // 增强错误日志，便于调试
      console.error('🚨 Error occurred:', {
        message: err.message,
        status: err.status ?? 500,
        stack: err.stack,
        name: err.name
      });

      // 特别处理toLowerCase相关错误
      if (err.message && err.message.includes('toLowerCase')) {
        console.error('🔍 toLowerCase error detected - this may be a client-side issue in Cursor');
      }

      return new Response(JSON.stringify({
        error: {
          message: err.message,
          type: err.name || 'error',
          code: err.status ?? 500
        }
      }), fixCors({
        status: err.status ?? 500,
        headers: { 'Content-Type': 'application/json' }
      }));
    };
    try {
      // 针对Cursor使用场景: 验证Authorization头存在但始终使用环境变量中的Gemini API Key
      const auth = request.headers.get("Authorization");
      const providedApiKey = auth?.split(" ")[1];

      // 验证请求包含Authorization头（用于兼容OpenAI客户端）
      if (!providedApiKey) {
        throw new HttpError("Authorization header is required. Please set your OpenAI API key in Cursor settings.", 401);
      }

      // 始终使用环境变量中的Gemini API Key数组，实现负载均衡
      let apiKeys;
      try {
        apiKeys = JSON.parse(process.env.GEMINI_API_KEY_LIST || '[]');
      } catch (parseError) {
        console.error('❌ Failed to parse GEMINI_API_KEY_LIST:', parseError.message);
        throw new HttpError("Invalid GEMINI_API_KEY_LIST format. Please ensure it's a valid JSON array.", 500);
      }

      if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
        throw new HttpError("No Gemini API keys configured. Please set GEMINI_API_KEY_LIST in Vercel environment variables.", 500);
      }

      const apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
      // 生产环境优化：仅记录关键信息
      console.log(`🔑 Selected Gemini API Key (${apiKeys.length} keys available)`);

      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };
      const { pathname } = new URL(request.url);
      console.log(`📡 ${request.method} ${pathname} - API Key Pool: ${apiKeys.length} keys`);

      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          let requestBody;
          try {
            requestBody = await request.json();
            console.log('📝 Request body parsed successfully');
          } catch (parseError) {
            console.error('❌ Failed to parse request JSON:', parseError.message);
            throw new HttpError("Invalid JSON in request body", 400);
          }
          return handleCompletions(requestBody, apiKey)
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey)
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

// 修复问题5: 更新API客户端版本信息
// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleModels(apiKey) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });
  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";
async function handleEmbeddings(req, apiKey) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    if (!req.model.startsWith("gemini-")) {
      req.model = DEFAULT_EMBEDDINGS_MODEL;
    }
    model = "models/" + req.model;
  }
  if (!Array.isArray(req.input)) {
    req.input = [req.input];
  }
  const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    })
  });
  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

// 修复问题4: 更新默认模型版本与参考实现一致
const DEFAULT_MODEL = "gemini-2.0-flash";
async function handleCompletions(req, apiKey) {
  // 添加请求参数调试日志
  console.log('🎯 handleCompletions called with:', {
    model: req.model,
    messagesCount: req.messages?.length,
    stream: req.stream,
    tools: req.tools?.length || 0
  });

  // 检查工具数量限制
  if (req.tools && req.tools.length > 50) {
    console.warn(`⚠️  Warning: ${req.tools.length} tools provided, this may exceed Gemini API limits`);
    console.log('🔧 Tool names:', req.tools.map(t => t.function?.name).slice(0, 10), '...');
  }

  // 验证必需的请求参数
  if (!req.messages || !Array.isArray(req.messages)) {
    throw new HttpError("Missing or invalid 'messages' field in request", 400);
  }

  if (req.messages.length === 0) {
    throw new HttpError("Messages array cannot be empty", 400);
  }

  let model = DEFAULT_MODEL;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("gemma-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
      break;
  }

  // 记录最终使用的模型
  console.log(`🤖 Using model: ${model} (requested: ${req.model || 'default'})`);

  // 检查模型是否可能不支持当前功能
  if (model.includes("2.5") && req.tools && req.tools.length > 0) {
    console.warn("⚠️  Note: gemini-2.5 models may have different tool calling requirements");
  }
  let body = await transformRequest(req);
  const extra = req.extra_body?.google
  if (extra) {
    if (extra.safety_settings) {
      body.safetySettings = extra.safety_settings;
    }
    if (extra.cached_content) {
      body.cachedContent = extra.cached_content;
    }
    if (extra.thinking_config) {
      body.generationConfig.thinkingConfig = extra.thinking_config;
    }
  }
  // 修复问题2: 正确处理Google Search工具
  const hasGoogleSearch = req.tools?.some(tool =>
    tool.type === "function" && tool.function?.name === 'googleSearch'
  );

  switch (true) {
    case model.endsWith(":search"):
      model = model.substring(0, model.length - 7);
    // eslint-disable-next-line no-fallthrough
    case req.model?.endsWith("-search-preview"):
    case hasGoogleSearch:
      body.tools = body.tools || [];
      body.tools.push({ googleSearch: {} });
      break;
  }
  // 仅在开发环境记录工具配置
  if (process.env.NODE_ENV === 'development') {
    console.log('🔧 Tools configuration:', body.tools);
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  // 添加响应状态监控
  console.log(`🌐 Gemini API Response: ${response.status} ${response.statusText}`);

  // 如果响应不成功，记录错误详情
  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Gemini API Error Details:', {
      status: response.status,
      statusText: response.statusText,
      body: errorText.substring(0, 1000) // 限制日志长度
    });

    // 尝试解析错误响应
    try {
      const errorJson = JSON.parse(errorText);
      console.error('🔍 Parsed error:', errorJson);
    } catch (e) {
      console.error('🔍 Raw error response:', errorText.substring(0, 500));
    }

    // 直接返回Gemini的错误响应
    return new Response(errorText, fixCors(response));
  }

  // 处理成功响应
  body = response.body;
  let id = "chatcmpl-" + generateId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
  const shared = {};

  if (req.stream) {
    body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream({
        transform: parseStream,
        flush: parseStreamFlush,
        buffer: "",
        shared,
      }))
      .pipeThrough(new TransformStream({
        transform: toOpenAiStream,
        flush: toOpenAiStreamFlush,
        streamIncludeUsage: req.stream_options?.include_usage,
        model, id, last: [],
        shared,
      }))
      .pipeThrough(new TextEncoderStream());
  } else {
    body = await response.text();
    try {
      body = JSON.parse(body);
      if (!body.candidates) {
        throw new Error("Invalid completion object");
      }
    } catch (err) {
      console.error("Error parsing response:", err);
      return new Response(body, fixCors(response)); // output as is
    }
    body = processCompletionsResponse(body, model, id);
  }

  return new Response(body, fixCors(response));
}

const adjustProps = (schemaPart) => {
  if (typeof schemaPart !== "object" || schemaPart === null) {
    return;
  }
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    // 移除Gemini API不支持的字段
    if (schemaPart.$schema) {
      delete schemaPart.$schema;
    }
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};
const adjustSchema = (schema) => {
  // 深度清理schema，移除Gemini API不支持的字段
  const cleanSchema = (obj) => {
    if (typeof obj !== "object" || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(cleanSchema);

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      // 跳过Gemini API不支持的字段
      if (key === '$schema' || key === 'strict' || key === 'additionalProperties') {
        continue;
      }
      cleaned[key] = cleanSchema(value);
    }
    return cleaned;
  };

  const cleanedSchema = cleanSchema(schema);
  // 不需要再调用adjustProps，因为cleanSchema已经处理了所有不兼容字段
  return cleanedSchema;
};

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount", // not for streaming
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK", // non-standard
  top_p: "topP",
};
const thinkingBudgetMap = {
  low: 1024,
  medium: 8192,
  high: 24576,
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
      // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  if (req.reasoning_effort) {
    cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new HttpError("Invalid image data: " + url, 400);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformFnResponse = ({ content, tool_call_id }, parts) => {
  if (!parts.calls) {
    throw new HttpError("No function calls found in the previous message", 400);
  }

  let response;
  try {
    // 优先尝试将工具返回的内容作为JSON解析
    response = JSON.parse(content);
  } catch (err) {
    // 如果解析失败，说明工具返回的是一个纯文本字符串（例如 read_file 或 run_terminal_cmd 的输出）。
    // 此时，我们将这个纯文本字符串包装成一个Gemini可以理解的标准JSON对象。
    console.log(`ℹ️ Tool response content is not valid JSON. Wrapping as string result. Content: "${content.substring(0, 70)}..."`);
    response = { result: content };
  }

  // 确保最终结果是一个对象，以防原始JSON是数字或字符串等非对象类型
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    response = { result: response };
  }

  if (!tool_call_id) {
    throw new HttpError("tool_call_id not specified", 400);
  }
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) {
    throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  }
  if (parts[i]) {
    throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  }

  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? tool_call_id.substring(5) : tool_call_id,
      name,
      response,
    }
  };
};


const transformFnCalls = ({ tool_calls }) => {
  const calls = {};
  const parts = tool_calls.map(({ function: { arguments: argstr, name }, id, type }, i) => {
    if (type !== "function") {
      throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    }
    let args;
    try {
      args = JSON.parse(argstr);
    } catch (err) {
      console.error("Error parsing function arguments:", err);
      throw new HttpError("Invalid function arguments: " + argstr, 400);
    }
    calls[id] = { i, name };
    return {
      functionCall: {
        id: id.startsWith("call_") ? id.substring(5) : id,
        name,
        args,
      }
    };
  });
  parts.calls = calls;
  return parts;
};

const transformMsg = async ({ content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return parts;
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    // 修复问题6: 创建消息副本避免修改原始对象
    let processedItem = item;

    switch (item.role) {
      case "system":
        system_instruction = { parts: await transformMsg(item) };
        continue;
      case "tool":
        // eslint-disable-next-line no-case-declarations
        let { role, parts } = contents[contents.length - 1] ?? {};
        if (role !== "function") {
          const calls = parts?.calls;
          parts = []; parts.calls = calls;
          contents.push({
            role: "function", // ignored
            parts
          });
        }
        transformFnResponse(item, parts);
        continue;
      case "assistant":
        // 创建新的消息对象，将assistant角色转换为model
        processedItem = { ...item, role: "model" };
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: processedItem.role,
      parts: processedItem.tool_calls ? transformFnCalls(processedItem) : await transformMsg(processedItem)
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some(part => part.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    // 修复问题2: 正确过滤掉googleSearch工具，避免传递给Gemini API
    let funcs = req.tools.filter(tool =>
      tool.type === "function" && tool.function?.name !== 'googleSearch'
    );

    // 1. 从环境变量 `GEMINI_MAX_TOOLS` 读取阈值，如果未设置，则默认为 15。
    // 选择 15 作为默认值比 20 更保守，以提高稳定性。
    const defaultMaxTools = 15;
    let MAX_TOOLS = parseInt(process.env.GEMINI_MAX_TOOLS, 10);

    // 2. 验证环境变量的值是否有效。如果无效或未设置，则使用默认值。
    if (isNaN(MAX_TOOLS) || MAX_TOOLS <= 0) {
      if (process.env.GEMINI_MAX_TOOLS) { // 仅当用户设置了无效值时才显示警告
        console.warn(`[Config] ⚠️ GEMINI_MAX_TOOLS 设置了无效的值 ('${process.env.GEMINI_MAX_TOOLS}'). 将使用默认值: ${defaultMaxTools}`);
      }
      MAX_TOOLS = defaultMaxTools;
    }

    // 3. 在日志中打印当前生效的工具数量限制，便于调试。
    console.log(`[Config] 🔧 Effective tool limit (MAX_TOOLS) is set to: ${MAX_TOOLS}`);

    // 4. 应用限制
    if (funcs.length > MAX_TOOLS) {
      console.warn(`⚠️  Limiting tools from ${funcs.length} to ${MAX_TOOLS} as per configuration.`);
      console.log('🔧 Kept tools:', funcs.slice(0, MAX_TOOLS).map(t => t.function?.name));
      console.log('🚫 Dropped tools:', funcs.slice(MAX_TOOLS).map(t => t.function?.name));
      funcs = funcs.slice(0, MAX_TOOLS);
    }

    if (funcs.length > 0) {
      console.log('🔧 Processing tool schemas...');
      funcs.forEach((tool, index) => {
        const originalSchema = JSON.stringify(tool.function.parameters);
        // 清理工具的参数schema
        tool.function.parameters = adjustSchema(tool.function.parameters);
        const cleanedSchema = JSON.stringify(tool.function.parameters);

        if (originalSchema !== cleanedSchema) {
          console.log(`🧹 Cleaned schema for tool ${tool.function.name}: removed unsupported fields`);
          if (process.env.NODE_ENV === 'development') {
            console.log(`   Original: ${originalSchema.substring(0, 200)}...`);
            console.log(`   Cleaned:  ${cleanedSchema.substring(0, 200)}...`);
          }
        }
      });
      tools = [{ function_declarations: funcs.map(schema => schema.function) }];
      console.log('✅ Tool schemas processed successfully');
    }
  }
  if (req.tool_choice) {
    const allowed_function_names = req.tool_choice?.type === "function" ? [req.tool_choice?.function?.name] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return { tools, tool_config };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

const generateId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => {
  const message = { role: "assistant", content: [] };
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        }
      });
    } else {
      message.content.push(part.text);
    }
  }
  message.content = message.content.join(SEP) || null;
  return {
    index: cand.index || 0, // 0-index is absent in new -002 models response
    [key]: message,
    logprobs: null,
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
    //original_finish_reason: cand.finishReason,
  };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const checkPromptBlock = (choices, promptFeedback, key) => {
  if (choices.length) { return; }
  if (promptFeedback?.blockReason) {
    console.log("Prompt block reason:", promptFeedback.blockReason);
    if (promptFeedback.blockReason === "SAFETY") {
      promptFeedback.safetyRatings
        .filter(r => r.blocked)
        .forEach(r => console.log(r));
    }
    choices.push({
      index: 0,
      [key]: null,
      finish_reason: "content_filter",
      //original_finish_reason: data.promptFeedback.blockReason,
    });
  }
  return true;
};

const processCompletionsResponse = (data, model, id) => {
  const obj = {
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now() / 1000),
    model: data.modelVersion ?? model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream(chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
function parseStreamFlush(controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now() / 1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};
function toOpenAiStream(line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    console.error("Error parsing response:", err);
    // 修复问题3: 修正语法错误
    if (!this.shared.is_buffers_rest) { line += delimiter; }
    controller.enqueue(line); // output as is
    return;
  }
  const obj = {
    id: this.id,
    choices: data.candidates.map(transformCandidatesDelta),
    //created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
    usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
  };
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  const cand = obj.choices[0];
  cand.index = cand.index || 0; // absent in new -002 models response
  const finish_reason = cand.finish_reason;
  cand.finish_reason = undefined;
  if (!this.last[cand.index]) { // first
    controller.enqueue(sseline({
      ...obj,
      choices: [{ ...cand, tool_calls: undefined, delta: { role: "assistant", content: "" } }],
    }));
  }
  delete cand.delta.role;
  if ("content" in cand.delta) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(sseline(obj));
  }
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && this.streamIncludeUsage) {
    obj.usage = transformUsage(data.usageMetadata);
  }
  cand.delta = {};
  this.last[cand.index] = obj;
}
function toOpenAiStreamFlush(controller) {
  if (this.last.length > 0) {
    for (const obj of this.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}

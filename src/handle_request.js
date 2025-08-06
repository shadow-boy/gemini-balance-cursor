import { handleVerification } from './verify_keys.js';
import openai from './openai.mjs';

export async function handleRequest(request) {

  const url = new URL(request.url);
  const pathname = url.pathname;
  const search = url.search;

  if (pathname === '/' || pathname === '/index.html') {
    return new Response('Proxy is Running!  More Details: https://github.com/tech-shrimp/gemini-balance-lite', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // 健康检查端点，用于Cursor等客户端验证服务状态
  if (pathname === '/health') {
    try {
      const apiKeys = JSON.parse(process.env.GEMINI_API_KEY_LIST || '[]');
      const status = {
        status: 'healthy',
        service: 'OpenAI-to-Gemini Proxy',
        timestamp: new Date().toISOString(),
        api_keys_count: apiKeys.length,
        endpoints: ['/v1/chat/completions', '/v1/embeddings', '/v1/models']
      };
      return new Response(JSON.stringify(status, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        status: 'error',
        message: 'Configuration error: ' + error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (pathname === '/verify' && request.method === 'POST') {
    return handleVerification(request);
  }

  // 处理OpenAI格式请求
  if (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/completions") || url.pathname.endsWith("/embeddings") || url.pathname.endsWith("/models")) {
    return openai.fetch(request);
  }

  const targetUrl = `https://generativelanguage.googleapis.com${pathname}${search}`;

  try {
    const headers = new Headers();
    const apiKeys = JSON.parse(process.env.GEMINI_API_KEY_LIST);
    if (apiKeys.length > 0) {
      const selectedKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
      console.log(`Gemini Selected API Key: ${selectedKey}`);
      headers.set('x-goog-api-key', selectedKey);
    }

    for (const [key, value] of request.headers.entries()) {
      // 防止key为null或undefined的情况，添加详细调试
      try {
        if (key && typeof key === 'string' && key.trim().toLowerCase() === 'content-type') {
          headers.set(key, value);
        }
      } catch (error) {
        console.error('❌ Error processing header:', { key, value, error: error.message });
        // 继续处理其他头部，不让单个错误阻止整个流程
      }
    }

    console.log('Request Sending to Gemini')
    console.log('targetUrl:' + targetUrl)
    console.log(headers)

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body
    });

    console.log("Call Gemini Success")

    const responseHeaders = new Headers(response.headers);

    console.log('Header from Gemini:')
    console.log(responseHeaders)

    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');
    responseHeaders.delete('keep-alive');
    responseHeaders.delete('content-encoding');
    responseHeaders.set('Referrer-Policy', 'no-referrer');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('Failed to fetch:', error);
    return new Response('Internal Server Error\n' + error?.stack, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};

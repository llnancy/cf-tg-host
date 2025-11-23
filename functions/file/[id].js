export async function onRequest(context) {
  const { request, env, params } = context;

  const url = new URL(request.url);
  let fileUrl = "https://telegra.ph/" + url.pathname + url.search;
  // 提取 Telegram file_id（不带扩展名）
  const fileId = url.pathname.split(".")[0].split("/")[2];
  // 防盗链（严格）：必须携带本站或白名单 Referer；否则 403，并禁止缓存
  const referer = request.headers.get("Referer");
  const allowed = new Set([
    url.origin,
    ...String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ]);
  let allowedReferer = env.ALLOWED_REFERER;
  if (referer || allowedReferer) {
    try {
      const r = new URL(referer);
      // 本地开发域名直接放行
      if (r.hostname === 'localhost' || r.hostname === '127.0.0.1') {
        allowedReferer = true;
      } else if (allowed.has(r.origin)) {
        allowedReferer = true;
      }
    } catch {}
  }
  if (!allowedReferer) {
    return new Response("Hotlink forbidden", {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
  if (fileId) {
    const filePath = await getFilePath(env, fileId);
    fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
  }

  const response = await fetch(fileUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });

  // Log response details
  console.log(response.ok, response.status);

  // If the response is OK, proceed with further checks
  if (response.ok) {

    // 从 URL 路径中提取完整的文件名（包括扩展名）
    const fullFileName = url.pathname.split("/").pop() || fileId;
    
    // Initialize minimal KV metadata if missing (key = fileId.ext)
    if (env.img_url && fileId) {
      const kvKey = fullFileName.includes('.') ? fullFileName : fileId;
      
      const record = await env.img_url.getWithMetadata(kvKey);
      if (!record || !record.metadata) {
        await env.img_url.put(kvKey, "", {
          metadata: { TimeStamp: Date.now() }
        });
      }
    }
    // 强制浏览器内联预览而不是下载
    const headers = new Headers(response.headers);
    // 透传类型，但覆盖 Content-Disposition
    const filename = fullFileName || "file";
    headers.set("Content-Disposition", `inline; filename="${filename}"`);
    const ext = filename.split(".").pop();
    if (ext) {
      const mime = {
        avif: "image/avif",
        bmp: "image/bmp",
        gif: "image/gif",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        jfif: "image/jpeg",
        png: "image/png",
        svg: "image/svg+xml",
        webp: "image/webp",
        mp4: "video/mp4",
        webm: "video/webm",
        mp3: "audio/mpeg",
        ogg: "audio/ogg",
        wav: "audio/wav",
        pdf: "application/pdf"
      }[ext.toLowerCase()];
      const currentContentType = headers.get("Content-Type");
      if (mime && (!currentContentType || currentContentType === "application/octet-stream")) {
        headers.set("Content-Type", mime);
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  return response;
}

async function getFilePath(env, file_id) {
  try {
    const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
    const res = await fetch(url, {
      method: "GET"
    });

    if (!res.ok) {
      console.error(`HTTP error! status: ${res.status}`);
      return null;
    }

    const responseData = await res.json();
    const { ok, result } = responseData;

    if (ok && result) {
      return result.file_path;
    } else {
      console.error("Error in response data:", responseData);
      return null;
    }
  } catch (error) {
    console.error("Error fetching file path:", error.message);
    return null;
  }
}

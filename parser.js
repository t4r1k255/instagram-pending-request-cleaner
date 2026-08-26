const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;

export async function parseInputFile(file) {
  if (!file) throw new Error("Bir dosya seçmelisin.");
  if (file.size > MAX_FILE_BYTES) throw new Error("Dosya 25 MB sınırını aşıyor.");

  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "xlsx") return parseXlsx(await file.arrayBuffer());

  const text = await file.text();
  if (extension === "json") return parseInstagramJson(text);
  if (extension === "html" || extension === "htm") return parseInstagramHtml(text);
  if (extension === "csv" || extension === "tsv") {
    const delimiter = extension === "tsv" ? "\t" : detectDelimiter(text);
    return { sheets: [{ name: "Liste", rows: parseDelimited(text, delimiter) }] };
  }
  throw new Error("Desteklenmeyen dosya türü.");
}

export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const candidates = [",", ";", "\t"];
  return candidates.sort((a, b) => countOutsideQuotes(firstLine, b) - countOutsideQuotes(firstLine, a))[0];
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === delimiter) count += 1;
  }
  return count;
}

export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((value) => String(value).trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => String(value).trim() !== "")) rows.push(row);
  return rows;
}

export function extractUsername(value) {
  if (value === null || value === undefined) return null;
  let raw = String(value).trim();
  if (!raw) return null;

  const urlMatch = raw.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:_u\/)?([A-Za-z0-9._]{1,30})(?:[/?#]|$)/i);
  if (urlMatch) raw = urlMatch[1];
  raw = raw.replace(/^@+/, "").replace(/^\/+|\/+$/g, "").trim();
  return /^[A-Za-z0-9._]{1,30}$/.test(raw) ? raw.toLowerCase() : null;
}

export function extractUsernames(rows, columnIndex, hasHeader = true) {
  return extractQueueItems(rows, columnIndex, hasHeader).map((item) => item.username);
}

export function extractQueueItems(rows, columnIndex, hasHeader = true) {
  const start = hasHeader ? 1 : 0;
  const exportFbidColumn = hasHeader ? findColumn(rows[0] || [], ["fbid", "export_fbid", "export fbid"]) : -1;
  const instagramUserIdColumn = hasHeader
    ? findColumn(rows[0] || [], ["instagram_user_id", "instagram user id", "target_user_id", "target user id"])
    : -1;
  const seen = new Set();
  const items = [];
  for (let i = start; i < rows.length; i += 1) {
    const username = extractUsername(rows[i]?.[columnIndex]);
    if (username && !seen.has(username)) {
      seen.add(username);
      items.push({
        username,
        exportFbid: exportFbidColumn >= 0 ? extractNumericId(rows[i]?.[exportFbidColumn]) : null,
        instagramUserId: instagramUserIdColumn >= 0 ? extractNumericId(rows[i]?.[instagramUserIdColumn]) : null
      });
    }
  }
  return items;
}

function findColumn(headerRow, labels) {
  const accepted = new Set(labels);
  return headerRow.findIndex((value) => accepted.has(String(value || "").trim().toLowerCase()));
}

function extractNumericId(value) {
  const id = String(value ?? "").trim();
  return /^\d{3,30}$/.test(id) ? id : null;
}

export function getHeaders(rows, hasHeader = true) {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, index) => {
    const given = hasHeader ? String(rows[0]?.[index] ?? "").trim() : "";
    return given || `Sütun ${columnName(index)}`;
  });
}

export function suggestUsernameColumn(headers) {
  const patterns = ["username", "user name", "kullanıcı adı", "kullanici adi", "profile", "profil", "href", "url"];
  const index = headers.findIndex((header) => patterns.some((pattern) => header.toLocaleLowerCase("tr-TR").includes(pattern)));
  return index >= 0 ? index : 0;
}

function parseInstagramJson(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (error) { throw new Error(`JSON dosyası okunamadı: ${error.message}`); }

  const found = new Map();
  const add = (value, exportFbid = null, instagramUserId = null) => {
    const username = extractUsername(value);
    if (!username) return;
    const normalizedExportFbid = extractNumericId(exportFbid);
    const normalizedInstagramUserId = extractNumericId(instagramUserId);
    const existing = found.get(username);
    if (!existing) {
      found.set(username, {
        username,
        exportFbid: normalizedExportFbid,
        instagramUserId: normalizedInstagramUserId
      });
      return;
    }
    if (!existing.exportFbid && normalizedExportFbid) existing.exportFbid = normalizedExportFbid;
    if (!existing.instagramUserId && normalizedInstagramUserId) existing.instagramUserId = normalizedInstagramUserId;
  };

  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node.label_values)) {
      const usernameField = node.label_values.find((field) => isUsernameLabel(field?.label));
      const urlField = node.label_values.find((field) => isProfileUrlLabel(field?.label));
      const exportFbid = node.fbid;
      const instagramUserId = node.instagram_user_id || node.target_user_id;
      if (usernameField?.value) add(usernameField.value, exportFbid, instagramUserId);
      else if (urlField?.value) add(urlField.value, exportFbid, instagramUserId);
    }

    if (Array.isArray(node.string_list_data)) {
      for (const entry of node.string_list_data) {
        if (entry && typeof entry === "object") {
          add(entry.value || entry.href, entry.fbid, entry.instagram_user_id || entry.target_user_id);
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "href" && typeof value === "string") add(value, node.fbid, node.instagram_user_id || node.target_user_id);
      else if (key !== "label_values" && key !== "string_list_data") walk(value);
    }
  };
  walk(data);
  return recordWorkbook([...found.values()]);
}

function normalizeJsonLabel(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function isUsernameLabel(value) {
  return ["username", "user name", "kullanici adi", "kullaniciadi"].includes(normalizeJsonLabel(value));
}

function isProfileUrlLabel(value) {
  return ["url", "profile url", "profil url", "profil adresi"].includes(normalizeJsonLabel(value));
}

function parseInstagramHtml(text) {
  const found = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of text.matchAll(anchorPattern)) {
    const username = extractUsername(match[1]) || extractUsername(stripTags(match[2]));
    if (username) found.push(username);
  }
  return listWorkbook(found);
}

function listWorkbook(values) {
  const unique = [...new Set(values)];
  if (!unique.length) throw new Error("Dosyada kullanıcı adı bulunamadı.");
  return { sheets: [{ name: "Bekleyen istekler", rows: [["username"], ...unique.map((value) => [value])] }] };
}

function recordWorkbook(records) {
  if (!records.length) throw new Error("Dosyada kullanıcı adı bulunamadı.");
  return {
    sheets: [{
      name: "Bekleyen istekler",
      rows: [
        ["username", "export_fbid", "instagram_user_id"],
        ...records.map((record) => [record.username, record.exportFbid || "", record.instagramUserId || ""])
      ]
    }]
  };
}

export async function parseXlsx(arrayBuffer) {
  const entries = await unzip(arrayBuffer);
  const workbookXml = getTextEntry(entries, "xl/workbook.xml");
  const relsXml = getTextEntry(entries, "xl/_rels/workbook.xml.rels");
  const sharedXml = entries.get("xl/sharedStrings.xml") ? decode(entries.get("xl/sharedStrings.xml")) : "";
  const sharedStrings = parseSharedStrings(sharedXml);
  const relations = parseRelationships(relsXml);
  const sheets = parseWorkbookSheets(workbookXml);

  const parsed = sheets.map((sheet) => {
    const target = relations.get(sheet.relationshipId);
    if (!target) throw new Error(`${sheet.name} sayfasının içeriği bulunamadı.`);
    const path = resolveZipPath("xl", target);
    const xml = getTextEntry(entries, path);
    return { name: sheet.name, rows: parseWorksheet(xml, sharedStrings) };
  });
  if (!parsed.length) throw new Error("Excel dosyasında çalışma sayfası bulunamadı.");
  return { sheets: parsed };
}

async function unzip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Geçerli bir XLSX/ZIP dosyası değil.");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let totalSize = 0;
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX dizini bozuk.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    totalSize += uncompressedSize;
    if (totalSize > MAX_UNCOMPRESSED_BYTES) throw new Error("Açılmış XLSX içeriği çok büyük.");

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(start, start + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = await inflateRaw(compressed);
    else throw new Error(`Desteklenmeyen XLSX sıkıştırma yöntemi: ${method}`);
    entries.set(name.replace(/^\//, ""), content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("Tarayıcı XLSX sıkıştırmasını desteklemiyor; CSV kullanabilirsin.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function getTextEntry(entries, path) {
  const value = entries.get(path);
  if (!value) throw new Error(`XLSX bileşeni eksik: ${path}`);
  return decode(value);
}

function parseWorkbookSheets(xml) {
  return [...xml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?\s*>/gi)].map((match) => ({
    name: xmlDecode(getAttribute(match[1], "name") || "Sayfa"),
    relationshipId: getAttribute(match[1], "r:id")
  })).filter((sheet) => sheet.relationshipId);
}

function parseRelationships(xml) {
  const map = new Map();
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/gi)) {
    const id = getAttribute(match[1], "Id");
    const target = getAttribute(match[1], "Target");
    const type = getAttribute(match[1], "Type") || "";
    if (id && target && type.includes("worksheet")) map.set(id, target);
  }
  return map;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi)]
    .map((match) => collectTextNodes(match[1]));
}

export function parseWorksheet(xml, sharedStrings = []) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/gi)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/gi)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const reference = getAttribute(attrs, "r") || "A1";
      const type = getAttribute(attrs, "t") || "";
      const index = columnIndex(reference.replace(/[0-9]/g, ""));
      const valueMatch = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i);
      let value = valueMatch ? xmlDecode(valueMatch[1]) : "";
      if (type === "s") value = sharedStrings[Number(value)] ?? "";
      else if (type === "inlineStr") value = collectTextNodes(body);
      else if (type === "b") value = value === "1" ? "TRUE" : "FALSE";
      row[index] = value;
    }
    rows.push(Array.from({ length: row.length }, (_, i) => row[i] ?? ""));
  }
  return rows;
}

function collectTextNodes(xml) {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
    .map((match) => xmlDecode(match[1]))
    .join("");
}

function getAttribute(fragment, name) {
  const escaped = name.replace(":", "\\:");
  const match = fragment.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function xmlDecode(value) {
  return String(value)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(value) { return xmlDecode(String(value).replace(/<[^>]*>/g, " ")).trim(); }
function decode(bytes) { return new TextDecoder("utf-8").decode(bytes); }

function resolveZipPath(base, target) {
  if (target.startsWith("/")) return target.replace(/^\//, "");
  const parts = `${base}/${target}`.split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function columnName(index) {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}

function columnIndex(name) {
  let result = 0;
  for (const char of name.toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

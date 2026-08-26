import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { detectDelimiter, parseDelimited, extractUsername, extractUsernames, extractQueueItems, getHeaders, suggestUsernameColumn, parseWorksheet, parseXlsx } from "../parser.js";

assert.equal(detectDelimiter("username;note\na;b"), ";");
assert.deepEqual(parseDelimited('username,note\n"john.doe","a,b"\n'), [["username", "note"], ["john.doe", "a,b"]]);
assert.equal(extractUsername("@John.Doe"), "john.doe");
assert.equal(extractUsername("https://www.instagram.com/_u/Test_User/?x=1"), "test_user");
assert.equal(extractUsername("not a username"), null);
assert.deepEqual(extractUsernames([["username"], ["A"], ["a"], ["B"]], 0, true), ["a", "b"]);
assert.deepEqual(extractQueueItems([
  ["username", "fbid", "instagram_user_id"],
  ["A", "123456", "987654"],
  ["B", "not-an-id", ""]
], 0, true), [
  { username: "a", exportFbid: "123456", instagramUserId: "987654" },
  { username: "b", exportFbid: null, instagramUserId: null }
]);
assert.deepEqual(getHeaders([["Name", ""]], true), ["Name", "Sütun B"]);
assert.equal(suggestUsernameColumn(["Tarih", "Kullanıcı Adı"]), 1);

const labeledJson = JSON.stringify([{
  fbid: "987654321",
  label_values: [
    { label: "Name", value: "singlewordname" },
    { label: "URL", value: "https://www.instagram.com/actual.user/" },
    { label: "Username", value: "Actual.User" }
  ]
}, {
  label_values: [
    { label: "Name", value: "anothername" },
    { label: "URL", value: "https://www.instagram.com/url_fallback/" }
  ]
}]);
const labeledWorkbook = await parseInputFileForTest("pending.json", labeledJson);
assert.deepEqual(labeledWorkbook.sheets[0].rows, [
  ["username", "export_fbid", "instagram_user_id"],
  ["actual.user", "987654321", ""],
  ["url_fallback", "", ""]
]);

const officialJson = JSON.stringify({ relationships_follow_requests_sent: [{ string_list_data: [{
  href: "https://www.instagram.com/official.user/", value: "official.user", timestamp: 1
}] }] });
const officialWorkbook = await parseInputFileForTest("pending.json", officialJson);
assert.deepEqual(officialWorkbook.sheets[0].rows, [
  ["username", "export_fbid", "instagram_user_id"],
  ["official.user", "", ""]
]);

const sheetXml = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>second.user</t></is></c></row></sheetData></worksheet>`;
assert.deepEqual(parseWorksheet(sheetXml, ["username"]), [["username"], ["second.user"]]);

const workbookXml = `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Requests" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const relsXml = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const sharedXml = `<?xml version="1.0"?><sst><si><t>username</t></si></sst>`;
const zip = makeStoredZip(new Map([
  ["xl/workbook.xml", workbookXml],
  ["xl/_rels/workbook.xml.rels", relsXml],
  ["xl/sharedStrings.xml", sharedXml],
  ["xl/worksheets/sheet1.xml", sheetXml]
]));
const parsed = await parseXlsx(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
assert.equal(parsed.sheets[0].name, "Requests");
assert.deepEqual(parsed.sheets[0].rows, [["username"], ["second.user"]]);

const compressedZip = makeStoredZip(new Map([
  ["xl/workbook.xml", workbookXml],
  ["xl/_rels/workbook.xml.rels", relsXml],
  ["xl/sharedStrings.xml", sharedXml],
  ["xl/worksheets/sheet1.xml", sheetXml]
]), true);
const compressedParsed = await parseXlsx(compressedZip.buffer.slice(compressedZip.byteOffset, compressedZip.byteOffset + compressedZip.byteLength));
assert.deepEqual(compressedParsed.sheets[0].rows, [["username"], ["second.user"]]);

console.log("parser tests: ok");

async function parseInputFileForTest(name, text) {
  const { parseInputFile } = await import("../parser.js");
  return parseInputFile({ name, size: Buffer.byteLength(text), text: async () => text });
}

function makeStoredZip(files, compress = false) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const packed = compress ? deflateRawSync(data) : data;
    const method = compress ? 8 : 0;
    const local = Buffer.alloc(30 + nameBytes.length + packed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    packed.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

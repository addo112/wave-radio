/**
 * Bethel Radio — Native Android APK Compiler & Signer (Zero external dependencies)
 * Produces a valid, 4-byte zipaligned, v1 + v2 signed Android APK at downloads/BethelRadio.apk
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';

// ============================================================================
// 1. Binary AndroidManifest.xml (AXML) Generator
// ============================================================================
function buildBinaryManifest() {
  // Attribute resource IDs in android.* must be sorted in ascending order in the resource map
  // and strings with resource IDs must appear first in the string pool!
  const attrDefs = [
    { name: 'theme',                 id: 0x01010000 },
    { name: 'label',                 id: 0x01010001 },
    { name: 'icon',                  id: 0x01010002 },
    { name: 'name',                  id: 0x01010003 },
    { name: 'exported',              id: 0x01010010 },
    { name: 'configChanges',         id: 0x0101001f },
    { name: 'minSdkVersion',         id: 0x0101020c },
    { name: 'versionCode',           id: 0x0101021b },
    { name: 'versionName',           id: 0x0101021c },
    { name: 'targetSdkVersion',      id: 0x01010270 },
    { name: 'allowBackup',           id: 0x01010280 },
    { name: 'hardwareAccelerated',   id: 0x010102d3 },
    { name: 'usesCleartextTraffic',  id: 0x010104ec },
  ];

  const otherStrings = [
    'android',
    'http://schemas.android.com/apk/res/android',
    '',
    'manifest',
    'package',
    'com.bethelradio.app',
    '1.0.0',
    'uses-sdk',
    'uses-permission',
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.ACCESS_WIFI_STATE',
    'android.permission.WAKE_LOCK',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'application',
    'Bethel Radio',
    'activity',
    'com.bethelradio.app.MainActivity',
    'intent-filter',
    'action',
    'android.intent.action.MAIN',
    'category',
    'android.intent.category.LAUNCHER',
  ];

  const allStrings = [...attrDefs.map((a) => a.name), ...otherStrings];
  const strIndex = (s) => {
    const idx = allStrings.indexOf(s);
    if (idx === -1) throw new Error(`Missing string in AXML pool: ${s}`);
    return idx;
  };

  // Build UTF-16LE String Pool Chunk (RES_STRING_POOL_TYPE = 0x0001)
  const encodedStrings = allStrings.map((s) => {
    const u16 = Buffer.from(s, 'utf16le');
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(s.length, 0);
    const nullTerm = Buffer.alloc(2, 0);
    return Buffer.concat([lenBuf, u16, nullTerm]);
  });

  const offsets = [];
  let curOffset = 0;
  for (const b of encodedStrings) {
    offsets.push(curOffset);
    curOffset += b.length;
  }
  const stringsDataRaw = Buffer.concat(encodedStrings);
  const padLen = (4 - (stringsDataRaw.length % 4)) % 4;
  const stringsData = Buffer.concat([stringsDataRaw, Buffer.alloc(padLen, 0)]);

  const stringPoolHeaderSize = 28;
  const offsetsSize = allStrings.length * 4;
  const stringsStart = stringPoolHeaderSize + offsetsSize;
  const stringPoolChunkSize = stringsStart + stringsData.length;

  const stringPoolChunk = Buffer.alloc(stringPoolChunkSize);
  stringPoolChunk.writeUInt16LE(0x0001, 0); // RES_STRING_POOL_TYPE
  stringPoolChunk.writeUInt16LE(stringPoolHeaderSize, 2);
  stringPoolChunk.writeUInt32LE(stringPoolChunkSize, 4);
  stringPoolChunk.writeUInt32LE(allStrings.length, 8);
  stringPoolChunk.writeUInt32LE(0, 12); // styleCount
  stringPoolChunk.writeUInt32LE(0, 16); // flags (UTF-16)
  stringPoolChunk.writeUInt32LE(stringsStart, 20);
  stringPoolChunk.writeUInt32LE(0, 24); // stylesStart
  offsets.forEach((off, i) => {
    stringPoolChunk.writeUInt32LE(off, stringPoolHeaderSize + i * 4);
  });
  stringsData.copy(stringPoolChunk, stringsStart);

  // Build Resource Map Chunk (RES_XML_RESOURCE_MAP_TYPE = 0x0180)
  const resMapSize = 8 + attrDefs.length * 4;
  const resMapChunk = Buffer.alloc(resMapSize);
  resMapChunk.writeUInt16LE(0x0180, 0);
  resMapChunk.writeUInt16LE(8, 2);
  resMapChunk.writeUInt32LE(resMapSize, 4);
  attrDefs.forEach((a, i) => {
    resMapChunk.writeUInt32LE(a.id, 8 + i * 4);
  });

  const NS_ANDROID = strIndex('http://schemas.android.com/apk/res/android');
  const NS_NONE = 0xffffffff;

  function makeNamespaceChunk(isStart, line) {
    const buf = Buffer.alloc(24);
    buf.writeUInt16LE(isStart ? 0x0100 : 0x0101, 0);
    buf.writeUInt16LE(16, 2);
    buf.writeUInt32LE(24, 4);
    buf.writeUInt32LE(line, 8);
    buf.writeUInt32LE(0xffffffff, 12);
    buf.writeUInt32LE(strIndex('android'), 16);
    buf.writeUInt32LE(NS_ANDROID, 20);
    return buf;
  }

  // Attribute value types:
  // 0x01 = TYPE_REFERENCE, 0x03 = TYPE_STRING, 0x10 = TYPE_INT_DEC, 0x11 = TYPE_INT_HEX, 0x12 = TYPE_INT_BOOLEAN
  function attrString(ns, name, valStr) {
    const idx = strIndex(valStr);
    return { ns, name: strIndex(name), rawValue: idx, dataType: 0x03, data: idx };
  }
  function attrIntDec(ns, name, num) {
    return { ns, name: strIndex(name), rawValue: 0xffffffff, dataType: 0x10, data: num >>> 0 };
  }
  function attrIntHex(ns, name, num) {
    return { ns, name: strIndex(name), rawValue: 0xffffffff, dataType: 0x11, data: num >>> 0 };
  }
  function attrBool(ns, name, boolVal) {
    return { ns, name: strIndex(name), rawValue: 0xffffffff, dataType: 0x12, data: boolVal ? 0xffffffff : 0 };
  }
  function attrRef(ns, name, resId) {
    return { ns, name: strIndex(name), rawValue: 0xffffffff, dataType: 0x01, data: resId >>> 0 };
  }

  function makeStartElement(tagName, line, attrs) {
    // Sort attributes that have resource IDs by their string index (which matches ascending resource ID order)
    const sortedAttrs = [...attrs].sort((a, b) => a.name - b.name);
    const totalSize = 36 + sortedAttrs.length * 20;
    const buf = Buffer.alloc(totalSize);
    buf.writeUInt16LE(0x0102, 0); // RES_XML_START_ELEMENT_TYPE
    buf.writeUInt16LE(16, 2);
    buf.writeUInt32LE(totalSize, 4);
    buf.writeUInt32LE(line, 8);
    buf.writeUInt32LE(0xffffffff, 12);
    buf.writeUInt32LE(NS_NONE, 16);
    buf.writeUInt32LE(strIndex(tagName), 20);
    buf.writeUInt16LE(20, 24); // attributeStart
    buf.writeUInt16LE(20, 26); // attributeSize
    buf.writeUInt16LE(sortedAttrs.length, 28); // attributeCount
    buf.writeUInt16LE(0, 30); // idIndex
    buf.writeUInt16LE(0, 32); // classIndex
    buf.writeUInt16LE(0, 34); // styleIndex

    sortedAttrs.forEach((a, i) => {
      const off = 36 + i * 20;
      buf.writeUInt32LE(a.ns, off);
      buf.writeUInt32LE(a.name, off + 4);
      buf.writeUInt32LE(a.rawValue, off + 8);
      buf.writeUInt16LE(8, off + 12); // Res_value size
      buf.writeUInt8(0, off + 14);    // res0
      buf.writeUInt8(a.dataType, off + 15);
      buf.writeUInt32LE(a.data, off + 16);
    });
    return buf;
  }

  function makeEndElement(tagName, line) {
    const buf = Buffer.alloc(24);
    buf.writeUInt16LE(0x0103, 0); // RES_XML_END_ELEMENT_TYPE
    buf.writeUInt16LE(16, 2);
    buf.writeUInt32LE(24, 4);
    buf.writeUInt32LE(line, 8);
    buf.writeUInt32LE(0xffffffff, 12);
    buf.writeUInt32LE(NS_NONE, 16);
    buf.writeUInt32LE(strIndex(tagName), 20);
    return buf;
  }

  const xmlNodes = [
    makeNamespaceChunk(true, 2),
    makeStartElement('manifest', 2, [
      attrIntDec(NS_ANDROID, 'versionCode', 1),
      attrString(NS_ANDROID, 'versionName', '1.0.0'),
      attrString(NS_NONE, 'package', 'com.bethelradio.app'),
    ]),

    makeStartElement('uses-sdk', 6, [
      attrIntDec(NS_ANDROID, 'minSdkVersion', 21),
      attrIntDec(NS_ANDROID, 'targetSdkVersion', 33),
    ]),
    makeEndElement('uses-sdk', 6),

    ...[
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.WAKE_LOCK',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
    ].flatMap((perm, idx) => [
      makeStartElement('uses-permission', 10 + idx, [attrString(NS_ANDROID, 'name', perm)]),
      makeEndElement('uses-permission', 10 + idx),
    ]),

    makeStartElement('application', 20, [
      attrRef(NS_ANDROID, 'theme', 0x01030129), // @android:style/Theme.DeviceDefault.NoActionBar
      attrString(NS_ANDROID, 'label', 'Bethel Radio'),
      attrRef(NS_ANDROID, 'icon', 0x7f010000),  // @drawable/ic_launcher
      attrBool(NS_ANDROID, 'allowBackup', true),
      attrBool(NS_ANDROID, 'hardwareAccelerated', true),
      attrBool(NS_ANDROID, 'usesCleartextTraffic', true),
    ]),

    makeStartElement('activity', 28, [
      attrString(NS_ANDROID, 'name', 'com.bethelradio.app.MainActivity'),
      attrString(NS_ANDROID, 'label', 'Bethel Radio'),
      attrBool(NS_ANDROID, 'exported', true),
      attrIntHex(NS_ANDROID, 'configChanges', 0x000004a0), // orientation|screenSize|keyboardHidden
    ]),

    makeStartElement('intent-filter', 34, []),
    makeStartElement('action', 35, [attrString(NS_ANDROID, 'name', 'android.intent.action.MAIN')]),
    makeEndElement('action', 35),
    makeStartElement('category', 36, [attrString(NS_ANDROID, 'name', 'android.intent.category.LAUNCHER')]),
    makeEndElement('category', 36),
    makeEndElement('intent-filter', 37),

    makeEndElement('activity', 38),
    makeEndElement('application', 39),
    makeEndElement('manifest', 40),
    makeNamespaceChunk(false, 40),
  ];

  const body = Buffer.concat([stringPoolChunk, resMapChunk, ...xmlNodes]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

// ============================================================================
// 2. Compiled Resource Table (resources.arsc) Generator
//    Maps 0x7f010000 (@drawable/ic_launcher) -> "res/drawable/ic_launcher.png"
// ============================================================================
function makeUtf8StringPool(strings) {
  const encoded = strings.map((s) => {
    const u8 = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([s.length, u8.length]), u8, Buffer.from([0])]);
  });
  const offsets = [];
  let cur = 0;
  for (const b of encoded) {
    offsets.push(cur);
    cur += b.length;
  }
  const raw = Buffer.concat(encoded);
  const pad = (4 - (raw.length % 4)) % 4;
  const data = Buffer.concat([raw, Buffer.alloc(pad, 0)]);

  const headerSize = 28;
  const offsetsSize = strings.length * 4;
  const stringsStart = headerSize + offsetsSize;
  const totalSize = stringsStart + data.length;

  const buf = Buffer.alloc(totalSize);
  buf.writeUInt16LE(0x0001, 0); // RES_STRING_POOL_TYPE
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(totalSize, 4);
  buf.writeUInt32LE(strings.length, 8);
  buf.writeUInt32LE(0, 12);
  buf.writeUInt32LE(0x00000100, 16); // UTF8_FLAG
  buf.writeUInt32LE(stringsStart, 20);
  buf.writeUInt32LE(0, 24);
  offsets.forEach((off, i) => buf.writeUInt32LE(off, headerSize + i * 4));
  data.copy(buf, stringsStart);
  return buf;
}

function buildResourcesArsc() {
  // Global value string pool: index 0 = "res/drawable/ic_launcher.png"
  const globalPool = makeUtf8StringPool(['res/drawable/ic_launcher.png']);
  // Type string pool: index 0 = "drawable"
  const typePool = makeUtf8StringPool(['drawable']);
  // Key string pool: index 0 = "ic_launcher"
  const keyPool = makeUtf8StringPool(['ic_launcher']);

  // RES_TABLE_TYPE_SPEC_TYPE (0x0202) for type 1 ("drawable") with 1 entry
  const typeSpec = Buffer.alloc(20);
  typeSpec.writeUInt16LE(0x0202, 0);
  typeSpec.writeUInt16LE(16, 2);
  typeSpec.writeUInt32LE(20, 4);
  typeSpec.writeUInt8(1, 8); // id = 1
  typeSpec.writeUInt8(0, 9);
  typeSpec.writeUInt16LE(0, 10);
  typeSpec.writeUInt32LE(1, 12); // entryCount = 1
  typeSpec.writeUInt32LE(0, 16); // config mask for entry 0

  // RES_TABLE_TYPE_TYPE (0x0201) for default config, 1 entry (0x7f010000)
  // Header size = 20 + 36 (ResTable_config) = 56 bytes
  // Offsets array = 1 * 4 = 4 bytes -> entriesStart = 60
  // Entry (ResTable_entry 8 bytes + Res_value 8 bytes) = 16 bytes -> total = 76 bytes
  const typeChunk = Buffer.alloc(76);
  typeChunk.writeUInt16LE(0x0201, 0);
  typeChunk.writeUInt16LE(56, 2); // headerSize
  typeChunk.writeUInt32LE(76, 4); // totalSize
  typeChunk.writeUInt8(1, 8);     // id = 1
  typeChunk.writeUInt8(0, 9);
  typeChunk.writeUInt16LE(0, 10);
  typeChunk.writeUInt32LE(1, 12); // entryCount = 1
  typeChunk.writeUInt32LE(60, 16); // entriesStart = 60
  typeChunk.writeUInt32LE(36, 20); // config.size = 36
  typeChunk.writeUInt32LE(0, 56);  // entry offset[0] = 0
  // ResTable_entry at offset 60:
  typeChunk.writeUInt16LE(8, 60);  // entry.size = 8
  typeChunk.writeUInt16LE(0, 62);  // entry.flags = 0
  typeChunk.writeUInt32LE(0, 64);  // entry.key = 0 ("ic_launcher")
  // Res_value at offset 68:
  typeChunk.writeUInt16LE(8, 68);  // value.size = 8
  typeChunk.writeUInt8(0, 70);     // res0 = 0
  typeChunk.writeUInt8(0x03, 71);  // dataType = TYPE_STRING (file path in global pool)
  typeChunk.writeUInt32LE(0, 72);  // data = 0 ("res/drawable/ic_launcher.png")

  // RES_TABLE_PACKAGE_TYPE (0x0200), headerSize = 288 bytes
  const pkgHeader = Buffer.alloc(288, 0);
  const pkgBody = Buffer.concat([typePool, keyPool, typeSpec, typeChunk]);
  const pkgTotalSize = 288 + pkgBody.length;
  pkgHeader.writeUInt16LE(0x0200, 0);
  pkgHeader.writeUInt16LE(288, 2);
  pkgHeader.writeUInt32LE(pkgTotalSize, 4);
  pkgHeader.writeUInt32LE(0x7f, 8); // package id = 0x7f
  pkgHeader.write('com.bethelradio.app', 12, 'utf16le');
  pkgHeader.writeUInt32LE(288, 268); // typeStrings offset
  pkgHeader.writeUInt32LE(1, 272);   // lastPublicType
  pkgHeader.writeUInt32LE(288 + typePool.length, 276); // keyStrings offset
  pkgHeader.writeUInt32LE(1, 280);   // lastPublicKey

  const pkgChunk = Buffer.concat([pkgHeader, pkgBody]);

  // RES_TABLE_TYPE (0x0002), headerSize = 12
  const tableHeader = Buffer.alloc(12);
  const tableTotalSize = 12 + globalPool.length + pkgChunk.length;
  tableHeader.writeUInt16LE(0x0002, 0);
  tableHeader.writeUInt16LE(12, 2);
  tableHeader.writeUInt32LE(tableTotalSize, 4);
  tableHeader.writeUInt32LE(1, 8); // packageCount = 1

  return Buffer.concat([tableHeader, globalPool, pkgChunk]);
}

// ============================================================================
// 3. Dalvik Executable (classes.dex) Generator
//    Implements com.bethelradio.app.MainActivity extends android.app.Activity
//    with full WebView setup, auto-play media, and back-button backgrounding.
// ============================================================================
function uleb128(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function buildClassesDex() {
  // DEX requires strings, types, protos, and methods to be strictly sorted!
  const rawStrings = [
    '<init>',
    'BethelRadioAndroidApp/1.0',
    'I',
    'L',
    ' Landroid/app/Activity;'.trim(),
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    'Lcom/bethelradio/app/MainActivity;',
    'Ljava/lang/String;',
    'MainActivity.java',
    'V',
    'VL',
    'VZ',
    'Z',
    'ZI',
    'file:///android_asset/index.html',
    'getSettings',
    'loadUrl',
    'moveTaskToBack',
    'onBackPressed',
    'onCreate',
    'setAllowContentAccess',
    'setAllowFileAccess',
    'setAllowFileAccessFromFileURLs',
    'setAllowUniversalAccessFromFileURLs',
    'setContentView',
    'setDatabaseEnabled',
    'setDomStorageEnabled',
    'setJavaScriptEnabled',
    'setMediaPlaybackRequiresUserGesture',
    'setMixedContentMode',
    'setWebChromeClient',
    'setWebViewClient',
  ].sort();

  const sIdx = (s) => {
    const i = rawStrings.indexOf(s);
    if (i === -1) throw new Error(`Missing DEX string: ${s}`);
    return i;
  };

  // Type descriptors sorted by their string_idx
  const typeDescStrings = [
    'I',
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    'Lcom/bethelradio/app/MainActivity;',
    'Ljava/lang/String;',
    'V',
    'Z',
  ].sort((a, b) => sIdx(a) - sIdx(b));

  const tIdx = (desc) => {
    const i = typeDescStrings.indexOf(desc);
    if (i === -1) throw new Error(`Missing DEX type: ${desc}`);
    return i;
  };

  // Prototypes sorted by (return_type_idx, parameters_type_idx_list)
  const protoDefs = [
    { shorty: 'L',  ret: 'Landroid/webkit/WebSettings;', params: [] },
    { shorty: 'V',  ret: 'V', params: [] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/content/Context;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/os/Bundle;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/view/View;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebChromeClient;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebViewClient;'] },
    { shorty: 'VL', ret: 'V', params: ['Ljava/lang/String;'] },
    { shorty: 'VZ', ret: 'V', params: ['I'] },
    { shorty: 'VZ', ret: 'V', params: ['Z'] },
    { shorty: 'ZI', ret: 'Z', params: ['Z'] },
  ];
  // Fix shorty for (I)V -> 'VI', (Z)Z -> 'ZZ'
  // Wait: let's add 'VI' and 'ZZ' to rawStrings if needed, or check shorty rules:
  // In Dalvik, shorty is ReturnType + ParamTypes ('V', 'Z', 'I', 'L' for reference).
  return buildVerifiedDex();
}

function buildVerifiedDex() {
  const strings = [
    '<init>',
    'I',
    'L',
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    'Lcom/bethelradio/app/MainActivity;',
    'Ljava/lang/String;',
    'MainActivity.java',
    'V',
    'VI',
    'VL',
    'VZ',
    'Z',
    'ZZ',
    'file:///android_asset/index.html',
    'getSettings',
    'loadUrl',
    'moveTaskToBack',
    'onBackPressed',
    'onCreate',
    'setAllowContentAccess',
    'setAllowFileAccess',
    'setAllowFileAccessFromFileURLs',
    'setAllowUniversalAccessFromFileURLs',
    'setContentView',
    'setDatabaseEnabled',
    'setDomStorageEnabled',
    'setJavaScriptEnabled',
    'setMediaPlaybackRequiresUserGesture',
    'setMixedContentMode',
    'setWebChromeClient',
    'setWebViewClient',
  ].sort();

  const sIdx = (s) => {
    const i = strings.indexOf(s);
    if (i === -1) throw new Error(`DEX string missing: ${s}`);
    return i;
  };

  const types = [
    'I',
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    'Lcom/bethelradio/app/MainActivity;',
    'Ljava/lang/String;',
    'V',
    'Z',
  ].sort((a, b) => sIdx(a) - sIdx(b));

  const tIdx = (t) => {
    const i = types.indexOf(t);
    if (i === -1) throw new Error(`DEX type missing: ${t}`);
    return i;
  };

  const protos = [
    { key: '()Landroid/webkit/WebSettings;', shorty: 'L',  ret: 'Landroid/webkit/WebSettings;', params: [] },
    { key: '()V',                            shorty: 'V',  ret: 'V', params: [] },
    { key: '(I)V',                           shorty: 'VI', ret: 'V', params: ['I'] },
    { key: '(Landroid/content/Context;)V',   shorty: 'VL', ret: 'V', params: ['Landroid/content/Context;'] },
    { key: '(Landroid/os/Bundle;)V',         shorty: 'VL', ret: 'V', params: ['Landroid/os/Bundle;'] },
    { key: '(Landroid/view/View;)V',         shorty: 'VL', ret: 'V', params: ['Landroid/view/View;'] },
    { key: '(Landroid/webkit/WebChromeClient;)V', shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebChromeClient;'] },
    { key: '(Landroid/webkit/WebViewClient;)V',   shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebViewClient;'] },
    { key: '(Ljava/lang/String;)V',          shorty: 'VL', ret: 'V', params: ['Ljava/lang/String;'] },
    { key: '(Z)V',                           shorty: 'VZ', ret: 'V', params: ['Z'] },
    { key: '(Z)Z',                           shorty: 'ZZ', ret: 'Z', params: ['Z'] },
  ].sort((a, b) => {
    const rDiff = tIdx(a.ret) - tIdx(b.ret);
    if (rDiff !== 0) return rDiff;
    const len = Math.min(a.params.length, b.params.length);
    for (let i = 0; i < len; i++) {
      const pDiff = tIdx(a.params[i]) - tIdx(b.params[i]);
      if (pDiff !== 0) return pDiff;
    }
    return a.params.length - b.params.length;
  });

  const pIdx = (key) => {
    const i = protos.findIndex((p) => p.key === key);
    if (i === -1) throw new Error(`DEX proto missing: ${key}`);
    return i;
  };

  const methods = [
    { cls: 'Landroid/app/Activity;',             name: '<init>',        proto: '()V' },
    { cls: 'Landroid/app/Activity;',             name: 'moveTaskToBack',proto: '(Z)Z' },
    { cls: 'Landroid/app/Activity;',             name: 'onCreate',      proto: '(Landroid/os/Bundle;)V' },
    { cls: 'Landroid/app/Activity;',             name: 'setContentView',proto: '(Landroid/view/View;)V' },
    { cls: 'Landroid/webkit/WebChromeClient;',   name: '<init>',        proto: '()V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setAllowContentAccess',              proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setAllowFileAccess',                 proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setAllowFileAccessFromFileURLs',     proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setAllowUniversalAccessFromFileURLs',proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setDatabaseEnabled',                 proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setDomStorageEnabled',               proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setJavaScriptEnabled',               proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setMediaPlaybackRequiresUserGesture',proto: '(Z)V' },
    { cls: 'Landroid/webkit/WebSettings;',       name: 'setMixedContentMode',                proto: '(I)V' },
    { cls: 'Landroid/webkit/WebView;',           name: '<init>',        proto: '(Landroid/content/Context;)V' },
    { cls: 'Landroid/webkit/WebView;',           name: 'getSettings',   proto: '()Landroid/webkit/WebSettings;' },
    { cls: 'Landroid/webkit/WebView;',           name: 'loadUrl',       proto: '(Ljava/lang/String;)V' },
    { cls: 'Landroid/webkit/WebView;',           name: 'setWebChromeClient', proto: '(Landroid/webkit/WebChromeClient;)V' },
    { cls: 'Landroid/webkit/WebView;',           name: 'setWebViewClient',   proto: '(Landroid/webkit/WebViewClient;)V' },
    { cls: 'Landroid/webkit/WebViewClient;',     name: '<init>',        proto: '()V' },
    { cls: 'Lcom/bethelradio/app/MainActivity;', name: '<init>',        proto: '()V' },
    { cls: 'Lcom/bethelradio/app/MainActivity;', name: 'onBackPressed', proto: '()V' },
    { cls: 'Lcom/bethelradio/app/MainActivity;', name: 'onCreate',      proto: '(Landroid/os/Bundle;)V' },
  ].sort((a, b) => {
    const cDiff = tIdx(a.cls) - tIdx(b.cls);
    if (cDiff !== 0) return cDiff;
    const nDiff = sIdx(a.name) - sIdx(b.name);
    if (nDiff !== 0) return nDiff;
    return pIdx(a.proto) - pIdx(b.proto);
  });

  const mIdx = (cls, name, proto) => {
    const i = methods.findIndex((m) => m.cls === cls && m.name === name && m.proto === proto);
    if (i === -1) throw new Error(`DEX method missing: ${cls}->${name}${proto}`);
    return i;
  };

  // Dalvik 16-bit code units helpers
  function insn35c(op, count, regC, regD, methodOrTypeIdx) {
    const b0 = op & 0xff;
    const b1 = ((count & 0x0f) << 4) | 0;
    const w0 = (b1 << 8) | b0;
    const w1 = methodOrTypeIdx & 0xffff;
    const w2 = ((regD & 0x0f) << 4) | (regC & 0x0f);
    return [w0, w1, w2];
  }
  function insn21c(op, regA, idx) {
    return [((regA & 0xff) << 8) | (op & 0xff), idx & 0xffff];
  }
  function insn11n(op, regA, lit4) {
    return [(((lit4 & 0x0f) << 12) | ((regA & 0x0f) << 8) | (op & 0xff))];
  }
  function insn11x(op, regA) {
    return [((regA & 0xff) << 8) | (op & 0xff)];
  }
  function insn10x(op) {
    return [op & 0xff];
  }

  function makeCodeItem(registersSize, insSize, outsSize, insnsWords) {
    const header = Buffer.alloc(16);
    header.writeUInt16LE(registersSize, 0);
    header.writeUInt16LE(insSize, 2);
    header.writeUInt16LE(outsSize, 4);
    header.writeUInt16LE(0, 6); // tries_size
    header.writeUInt32LE(0, 8); // debug_info_off
    header.writeUInt32LE(insnsWords.length, 12);
    const insnsBuf = Buffer.alloc(insnsWords.length * 2);
    insnsWords.forEach((w, i) => insnsBuf.writeUInt16LE(w, i * 2));
    const raw = Buffer.concat([header, insnsBuf]);
    const pad = (4 - (raw.length % 4)) % 4;
    return Buffer.concat([raw, Buffer.alloc(pad, 0)]);
  }

  // Method 1: MainActivity.<init>()V
  // registers = 1 (v0 = this), ins = 1, outs = 1
  const initCode = makeCodeItem(1, 1, 1, [
    ...insn35c(0x70, 1, 0, 0, mIdx('Landroid/app/Activity;', '<init>', '()V')), // invoke-direct {v0}, Activity.<init>
    ...insn10x(0x0e), // return-void
  ]);

  // Method 2: MainActivity.onBackPressed()V
  // registers = 2 (v0, v1 = this), ins = 1, outs = 2
  const onBackPressedCode = makeCodeItem(2, 1, 2, [
    ...insn11n(0x12, 0, 1), // const/4 v0, 0x1
    ...insn35c(0x6e, 2, 1, 0, mIdx('Landroid/app/Activity;', 'moveTaskToBack', '(Z)Z')), // invoke-virtual {v1, v0}, moveTaskToBack(true)
    ...insn10x(0x0e), // return-void
  ]);

  // Method 3: MainActivity.onCreate(Bundle)V
  // registers = 6 (v0, v1, v2, v3, v4 = this, v5 = bundle), ins = 2, outs = 2
  const onCreateCode = makeCodeItem(6, 2, 2, [
    // super.onCreate(savedInstanceState)
    ...insn35c(0x6f, 2, 4, 5, mIdx('Landroid/app/Activity;', 'onCreate', '(Landroid/os/Bundle;)V')),
    // v0 = new WebView(this)
    ...insn21c(0x22, 0, tIdx('Landroid/webkit/WebView;')),
    ...insn35c(0x70, 2, 0, 4, mIdx('Landroid/webkit/WebView;', '<init>', '(Landroid/content/Context;)V')),
    // v1 = v0.getSettings()
    ...insn35c(0x6e, 1, 0, 0, mIdx('Landroid/webkit/WebView;', 'getSettings', '()Landroid/webkit/WebSettings;')),
    ...insn11x(0x0c, 1), // move-result-object v1
    // v2 = true (1), v3 = false (0)
    ...insn11n(0x12, 2, 1),
    ...insn11n(0x12, 3, 0),
    // Configure WebSettings for live radio streaming & background audio
    ...insn35c(0x6e, 2, 1, 2, mIdx('Landroid/webkit/WebSettings;', 'setJavaScriptEnabled', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 2, mIdx('Landroid/webkit/WebSettings;', 'setDomStorageEnabled', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 2, mIdx('Landroid/webkit/WebSettings;', 'setDatabaseEnabled', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 3, mIdx('Landroid/webkit/WebSettings;', 'setMediaPlaybackRequiresUserGesture', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 2, mIdx('Landroid/webkit/WebSettings;', 'setAllowFileAccess', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 2, mIdx('Landroid/webkit/WebSettings;', 'setAllowContentAccess', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 2, mIdx('Landroid/webkit/WebSettings;', 'setAllowFileAccessFromFileURLs', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 2, mIdx('Landroid/webkit/WebSettings;', 'setAllowUniversalAccessFromFileURLs', '(Z)V')),
    ...insn35c(0x6e, 2, 1, 3, mIdx('Landroid/webkit/WebSettings;', 'setMixedContentMode', '(I)V')),
    // v0.setWebViewClient(new WebViewClient())
    ...insn21c(0x22, 2, tIdx('Landroid/webkit/WebViewClient;')),
    ...insn35c(0x70, 1, 2, 0, mIdx('Landroid/webkit/WebViewClient;', '<init>', '()V')),
    ...insn35c(0x6e, 2, 0, 2, mIdx('Landroid/webkit/WebView;', 'setWebViewClient', '(Landroid/webkit/WebViewClient;)V')),
    // v0.setWebChromeClient(new WebChromeClient())
    ...insn21c(0x22, 2, tIdx('Landroid/webkit/WebChromeClient;')),
    ...insn35c(0x70, 1, 2, 0, mIdx('Landroid/webkit/WebChromeClient;', '<init>', '()V')),
    ...insn35c(0x6e, 2, 0, 2, mIdx('Landroid/webkit/WebView;', 'setWebChromeClient', '(Landroid/webkit/WebChromeClient;)V')),
    // this.setContentView(v0)
    ...insn35c(0x6e, 2, 4, 0, mIdx('Landroid/app/Activity;', 'setContentView', '(Landroid/view/View;)V')),
    // v0.loadUrl("file:///android_asset/index.html")
    ...insn21c(0x1a, 2, sIdx('file:///android_asset/index.html')),
    ...insn35c(0x6e, 2, 0, 2, mIdx('Landroid/webkit/WebView;', 'loadUrl', '(Ljava/lang/String;)V')),
    ...insn10x(0x0e), // return-void
  ]);

  // Layout DEX sections sequentially with 4-byte alignment
  const headerSize = 0x70; // 112 bytes
  const stringIdsSize = strings.length * 4;
  const typeIdsSize = types.length * 4;
  const protoIdsSize = protos.length * 12;
  const methodIdsSize = methods.length * 8;
  const classDefsSize = 32; // 1 class_def

  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + stringIdsSize;
  const protoIdsOff = typeIdsOff + typeIdsSize;
  const methodIdsOff = protoIdsOff + protoIdsSize;
  const classDefsOff = methodIdsOff + methodIdsSize;
  const dataOff = classDefsOff + classDefsSize;

  let cursor = dataOff;
  const dataChunks = [];
  function appendData(buf, align = 4) {
    if (align > 1) {
      const pad = (align - (cursor % align)) % align;
      if (pad > 0) {
        dataChunks.push(Buffer.alloc(pad, 0));
        cursor += pad;
      }
    }
    const off = cursor;
    dataChunks.push(buf);
    cursor += buf.length;
    return off;
  }

  // 1. Type lists for protos with parameters
  const protoParamOffsets = protos.map((p) => {
    if (p.params.length === 0) return 0;
    const b = Buffer.alloc(4 + p.params.length * 2);
    b.writeUInt32LE(p.params.length, 0);
    p.params.forEach((pt, i) => b.writeUInt16LE(tIdx(pt), 4 + i * 2));
    return appendData(b, 4);
  });

  // 2. Code items (4-byte aligned)
  const initCodeOff = appendData(initCode, 4);
  const onBackPressedCodeOff = appendData(onBackPressedCode, 4);
  const onCreateCodeOff = appendData(onCreateCode, 4);

  // 3. String data items
  const stringDataOffsets = strings.map((s) => {
    const utf8 = Buffer.from(s, 'utf8');
    const item = Buffer.concat([uleb128(s.length), utf8, Buffer.from([0])]);
    return appendData(item, 1);
  });

  // 4. Class data item for MainActivity
  // 1 direct method (<init>), 2 virtual methods (onBackPressed, onCreate)
  const initMIdx = mIdx('Lcom/bethelradio/app/MainActivity;', '<init>', '()V');
  const backMIdx = mIdx('Lcom/bethelradio/app/MainActivity;', 'onBackPressed', '()V');
  const createMIdx = mIdx('Lcom/bethelradio/app/MainActivity;', 'onCreate', '(Landroid/os/Bundle;)V');

  const classDataItem = Buffer.concat([
    uleb128(0), // static_fields_size
    uleb128(0), // instance_fields_size
    uleb128(1), // direct_methods_size
    uleb128(2), // virtual_methods_size
    // direct_methods[0]: <init> (ACC_PUBLIC | ACC_CONSTRUCTOR = 0x10001)
    uleb128(initMIdx),
    uleb128(0x10001),
    uleb128(initCodeOff),
    // virtual_methods[0]: onBackPressed (ACC_PUBLIC = 0x0001)
    uleb128(backMIdx),
    uleb128(0x0001),
    uleb128(onBackPressedCodeOff),
    // virtual_methods[1]: onCreate (ACC_PROTECTED = 0x0004)
    uleb128(createMIdx - backMIdx),
    uleb128(0x0004),
    uleb128(onCreateCodeOff),
  ]);
  const classDataOff = appendData(classDataItem, 1);

  // 5. Map list (4-byte aligned at end of data section)
  const mapItems = [
    { type: 0x0000, size: 1, offset: 0 },
    { type: 0x0001, size: strings.length, offset: stringIdsOff },
    { type: 0x0002, size: types.length, offset: typeIdsOff },
    { type: 0x0003, size: protos.length, offset: protoIdsOff },
    { type: 0x0005, size: methods.length, offset: methodIdsOff },
    { type: 0x0006, size: 1, offset: classDefsOff },
    { type: 0x1001, size: protos.filter((p) => p.params.length > 0).length, offset: protoParamOffsets.find((o) => o > 0) },
    { type: 0x2001, size: 3, offset: initCodeOff },
    { type: 0x2002, size: strings.length, offset: stringDataOffsets[0] },
    { type: 0x2000, size: 1, offset: classDataOff },
  ];
  const mapOff = cursor + ((4 - (cursor % 4)) % 4);
  mapItems.push({ type: 0x1000, size: 1, offset: mapOff });

  const mapBuf = Buffer.alloc(4 + mapItems.length * 12);
  mapBuf.writeUInt32LE(mapItems.length, 0);
  mapItems.forEach((m, i) => {
    const off = 4 + i * 12;
    mapBuf.writeUInt16LE(m.type, off);
    mapBuf.writeUInt16LE(0, off + 2);
    mapBuf.writeUInt32LE(m.size, off + 4);
    mapBuf.writeUInt32LE(m.offset, off + 8);
  });
  appendData(mapBuf, 4);

  const fileSize = cursor;
  const dataSize = fileSize - dataOff;

  // Assemble full DEX buffer
  const dex = Buffer.alloc(fileSize, 0);
  // Magic: "dex\n035\0"
  Buffer.from([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00]).copy(dex, 0);
  dex.writeUInt32LE(fileSize, 32);
  dex.writeUInt32LE(0x70, 36);
  dex.writeUInt32LE(0x12345678, 40); // ENDIAN_CONSTANT
  dex.writeUInt32LE(0, 44); // link_size
  dex.writeUInt32LE(0, 48); // link_off
  dex.writeUInt32LE(mapOff, 52);
  dex.writeUInt32LE(strings.length, 56);
  dex.writeUInt32LE(stringIdsOff, 60);
  dex.writeUInt32LE(types.length, 64);
  dex.writeUInt32LE(typeIdsOff, 68);
  dex.writeUInt32LE(protos.length, 72);
  dex.writeUInt32LE(protoIdsOff, 76);
  dex.writeUInt32LE(0, 80); // field_ids_size
  dex.writeUInt32LE(0, 84); // field_ids_off
  dex.writeUInt32LE(methods.length, 88);
  dex.writeUInt32LE(methodIdsOff, 92);
  dex.writeUInt32LE(1, 96); // class_defs_size
  dex.writeUInt32LE(classDefsOff, 100);
  dex.writeUInt32LE(dataSize, 104);
  dex.writeUInt32LE(dataOff, 108);

  // Write string_ids
  stringDataOffsets.forEach((off, i) => dex.writeUInt32LE(off, stringIdsOff + i * 4));
  // Write type_ids
  types.forEach((t, i) => dex.writeUInt32LE(sIdx(t), typeIdsOff + i * 4));
  // Write proto_ids
  protos.forEach((p, i) => {
    const off = protoIdsOff + i * 12;
    dex.writeUInt32LE(sIdx(p.shorty), off);
    dex.writeUInt32LE(tIdx(p.ret), off + 4);
    dex.writeUInt32LE(protoParamOffsets[i], off + 8);
  });
  // Write method_ids
  methods.forEach((m, i) => {
    const off = methodIdsOff + i * 8;
    dex.writeUInt16LE(tIdx(m.cls), off);
    dex.writeUInt16LE(pIdx(m.proto), off + 2);
    dex.writeUInt32LE(sIdx(m.name), off + 4);
  });
  // Write class_def[0]
  dex.writeUInt32LE(tIdx('Lcom/bethelradio/app/MainActivity;'), classDefsOff);
  dex.writeUInt32LE(0x0001, classDefsOff + 4); // ACC_PUBLIC
  dex.writeUInt32LE(tIdx('Landroid/app/Activity;'), classDefsOff + 8); // superclass
  dex.writeUInt32LE(0, classDefsOff + 12); // interfaces_off
  dex.writeUInt32LE(sIdx('MainActivity.java'), classDefsOff + 16); // source_file_idx
  dex.writeUInt32LE(0, classDefsOff + 20); // annotations_off
  dex.writeUInt32LE(classDataOff, classDefsOff + 24);
  dex.writeUInt32LE(0, classDefsOff + 28); // static_values_off

  // Copy data section
  Buffer.concat(dataChunks).copy(dex, dataOff);

  // Compute SHA-1 signature (bytes 32..end) and store at offset 12..31
  const sha1 = crypto.createHash('sha1').update(dex.subarray(32)).digest();
  sha1.copy(dex, 12);

  // Compute Adler32 checksum (bytes 12..end) and store at offset 8..11
  const checksum = adler32(dex.subarray(12));
  dex.writeUInt32LE(checksum, 8);

  return dex;
}

// ============================================================================
// 4. ASN.1 DER + Self-Signed X.509 Certificate + PKCS#7 (v1) + APK Sig v2
// ============================================================================
function derLen(len) {
  if (len < 128) return Buffer.from([len]);
  const hex = len.toString(16).padStart(len > 255 ? 4 : 2, '0');
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
}
function derNode(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}
function derSeq(...items) {
  return derNode(0x30, Buffer.concat(items));
}
function derSet(...items) {
  return derNode(0x31, Buffer.concat(items));
}
function derOid(oidBytes) {
  return derNode(0x06, Buffer.from(oidBytes));
}
function derInt(numOrBuf) {
  let b = Buffer.isBuffer(numOrBuf) ? numOrBuf : Buffer.from([numOrBuf]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return derNode(0x02, b);
}
function derUtcTime(str) {
  return derNode(0x17, Buffer.from(str, 'ascii'));
}
function derUtf8(str) {
  return derNode(0x0c, Buffer.from(str, 'utf8'));
}
function derOctetString(buf) {
  return derNode(0x04, buf);
}

function generateSigningKeyAndCert() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sigAlg = derSeq(derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  // CN=Bethel Radio (2.5.4.3)
  const name = derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8('Bethel Radio'))));
  const validity = derSeq(derUtcTime('240101000000Z'), derUtcTime('491231235959Z'));
  const serial = derInt(Buffer.from([0x01, 0x42, 0x65, 0x74, 0x68, 0x65, 0x6c]));

  const tbsCert = derSeq(
    derNode(0xa0, derInt(2)), // v3
    serial,
    sigAlg,
    name,
    validity,
    name,
    spkiDer
  );

  const sig = crypto.sign('sha256', tbsCert, privateKey);
  const bitString = derNode(0x03, Buffer.concat([Buffer.from([0x00]), sig]));
  const certDer = derSeq(tbsCert, sigAlg, bitString);

  return { privateKey, publicKey, spkiDer, certDer, serial, name };
}

function createPkcs7Signature(sfBuffer, certInfo) {
  const { privateKey, certDer, serial, name } = certInfo;
  const sig = crypto.sign('sha256', sfBuffer, privateKey);

  // PKCS#7 SignedData (1.2.840.113549.1.7.2)
  const oidData = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);
  const oidSignedData = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
  const sha256Alg = derSeq(derOid([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]), Buffer.from([0x05, 0x00]));
  const rsaEncryptionAlg = derSeq(derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]), Buffer.from([0x05, 0x00]));

  const signerInfo = derSeq(
    derInt(1),
    derSeq(name, serial),
    sha256Alg,
    rsaEncryptionAlg,
    derOctetString(sig)
  );

  const signedData = derSeq(
    derInt(1),
    derSet(sha256Alg),
    derSeq(oidData),
    derNode(0xa0, certDer),
    derSet(signerInfo)
  );

  return derSeq(oidSignedData, derNode(0xa0, signedData));
}

// APK Signature Scheme v2 helper: length-prefixed slice
function lenPrefixed(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function computeApkV2ContentDigest(sections) {
  // Algorithm 0x0103 (RSASSA-PKCS1-v1_5 with SHA2-256), 1 MB chunks
  const CHUNK_SIZE = 1024 * 1024;
  const chunkDigests = [];

  for (const sec of sections) {
    let offset = 0;
    while (offset < sec.length) {
      const slice = sec.subarray(offset, Math.min(offset + CHUNK_SIZE, sec.length));
      const header = Buffer.alloc(5);
      header[0] = 0xa5;
      header.writeUInt32LE(slice.length, 1);
      const d = crypto.createHash('sha256').update(header).update(slice).digest();
      chunkDigests.push(d);
      offset += CHUNK_SIZE;
    }
  }

  const topHeader = Buffer.alloc(5);
  topHeader[0] = 0x5a;
  topHeader.writeUInt32LE(chunkDigests.length, 1);
  return crypto.createHash('sha256').update(topHeader).update(Buffer.concat(chunkDigests)).digest();
}

function buildApkSigBlockV2(beforeCd, cd, eocdForDigest, certInfo) {
  const { privateKey, spkiDer, certDer } = certInfo;
  const SIG_ALG_RSA_PKCS1_V1_5_SHA256 = 0x0103;

  const topDigest = computeApkV2ContentDigest([beforeCd, cd, eocdForDigest]);

  // digest entry: uint32 sigAlgId + lenPrefixed(digest)
  const algBuf = Buffer.alloc(4);
  algBuf.writeUInt32LE(SIG_ALG_RSA_PKCS1_V1_5_SHA256, 0);
  const digestEntry = lenPrefixed(Buffer.concat([algBuf, lenPrefixed(topDigest)]));
  const digestsSeq = lenPrefixed(digestEntry);

  const certsSeq = lenPrefixed(lenPrefixed(certDer));
  const additionalAttrsSeq = lenPrefixed(Buffer.alloc(0));

  const signedData = Buffer.concat([digestsSeq, certsSeq, additionalAttrsSeq]);

  // Sign signedData with RSA-PKCS1-v1_5-SHA256
  const signatureBytes = crypto.sign('sha256', signedData, privateKey);
  const sigEntry = lenPrefixed(Buffer.concat([algBuf, lenPrefixed(signatureBytes)]));
  const signaturesSeq = lenPrefixed(sigEntry);

  const signer = lenPrefixed(Buffer.concat([
    lenPrefixed(signedData),
    signaturesSeq,
    lenPrefixed(spkiDer),
  ]));
  const signersSeq = lenPrefixed(signer);

  // Pair ID = 0x7109871a (APK Signature Scheme v2 Block ID)
  const pairValue = signersSeq;
  const pairLen = 4 + pairValue.length;
  const pairBuf = Buffer.alloc(8 + pairLen);
  pairBuf.writeBigUInt64LE(BigInt(pairLen), 0);
  pairBuf.writeUInt32LE(0x7109871a, 8);
  pairValue.copy(pairBuf, 12);

  // Pad block so total size is a multiple of 4096 bytes (Android Verity / alignment best practice)
  const blockSizeExcludingFirst8 = pairBuf.length + 8 + 16;
  const blockBuf = Buffer.alloc(8 + blockSizeExcludingFirst8);
  blockBuf.writeBigUInt64LE(BigInt(blockSizeExcludingFirst8), 0);
  pairBuf.copy(blockBuf, 8);
  blockBuf.writeBigUInt64LE(BigInt(blockSizeExcludingFirst8), 8 + pairBuf.length);
  Buffer.from('APK Sig Block 42', 'ascii').copy(blockBuf, 8 + pairBuf.length + 8);
  return blockBuf;
}

// ============================================================================
// 5. ZIP / APK Packager with 4-Byte Alignment (zipalign) + v1 & v2 Signatures
// ============================================================================
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildSignedApk(entries, certInfo) {
  // Generate v1 META-INF files first
  const mfLines = [
    'Manifest-Version: 1.0',
    'Created-By: 1.0 (Bethel Radio Android Builder)',
    '',
  ];
  const sfEntries = [];

  for (const e of entries) {
    const sha = crypto.createHash('sha256').update(e.data).digest('base64');
    const chunk = `Name: ${e.name}\r\nSHA-256-Digest: ${sha}\r\n\r\n`;
    mfLines.push(`Name: ${e.name}`, `SHA-256-Digest: ${sha}`, '');
    const sfSha = crypto.createHash('sha256').update(Buffer.from(chunk, 'utf8')).digest('base64');
    sfEntries.push(`Name: ${e.name}`, `SHA-256-Digest: ${sfSha}`, '');
  }

  const mfBuffer = Buffer.from(mfLines.join('\r\n'), 'utf8');
  const mfDigest = crypto.createHash('sha256').update(mfBuffer).digest('base64');
  const sfLines = [
    'Signature-Version: 1.0',
    'Created-By: 1.0 (Bethel Radio Android Builder)',
    `SHA-256-Digest-Manifest: ${mfDigest}`,
    '',
    ...sfEntries,
  ];
  const sfBuffer = Buffer.from(sfLines.join('\r\n'), 'utf8');
  const rsaBuffer = createPkcs7Signature(sfBuffer, certInfo);

  const allEntries = [
    ...entries,
    { name: 'META-INF/MANIFEST.MF', data: mfBuffer, store: false },
    { name: 'META-INF/CERT.SF',     data: sfBuffer, store: false },
    { name: 'META-INF/CERT.RSA',    data: rsaBuffer, store: false },
  ];

  const localHeaders = [];
  const cdRecords = [];
  let offset = 0;

  for (const item of allEntries) {
    const nameBuf = Buffer.from(item.name, 'utf8');
    const uncompressedSize = item.data.length;
    const crc = crc32(item.data);

    let compMethod = 8; // DEFLATE
    let compData;
    if (item.store) {
      compMethod = 0; // STORE (uncompressed)
      compData = item.data;
    } else {
      compData = zlib.deflateRawSync(item.data, { level: 9 });
      if (compData.length >= uncompressedSize) {
        compMethod = 0;
        compData = item.data;
      }
    }

    // For uncompressed (STORE) entries, 4-byte align the file data offset (zipalign -p 4)
    let extraLen = 0;
    if (compMethod === 0) {
      const dataStart = offset + 30 + nameBuf.length;
      extraLen = (4 - (dataStart % 4)) % 4;
    }

    const lfh = Buffer.alloc(30 + nameBuf.length + extraLen);
    lfh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lfh.writeUInt16LE(20, 4);         // Version needed (2.0)
    lfh.writeUInt16LE(0, 6);          // Flags
    lfh.writeUInt16LE(compMethod, 8);
    lfh.writeUInt16LE(0x0000, 10);    // Mod time
    lfh.writeUInt16LE(0x5421, 12);    // Mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compData.length, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(extraLen, 28);
    nameBuf.copy(lfh, 30);

    const localOffset = offset;
    localHeaders.push(lfh, compData);
    offset += lfh.length + compData.length;

    const cdr = Buffer.alloc(46 + nameBuf.length);
    cdr.writeUInt32LE(0x02014b50, 0); // Central directory signature
    cdr.writeUInt16LE(20, 4);         // Version made by
    cdr.writeUInt16LE(20, 6);         // Version needed
    cdr.writeUInt16LE(0, 8);
    cdr.writeUInt16LE(compMethod, 10);
    cdr.writeUInt16LE(0x0000, 12);
    cdr.writeUInt16LE(0x5421, 14);
    cdr.writeUInt32LE(crc, 16);
    cdr.writeUInt32LE(compData.length, 20);
    cdr.writeUInt32LE(uncompressedSize, 24);
    cdr.writeUInt16LE(nameBuf.length, 28);
    cdr.writeUInt16LE(0, 30);         // Extra field length in CD = 0
    cdr.writeUInt16LE(0, 32);         // Comment length
    cdr.writeUInt16LE(0, 34);         // Disk number
    cdr.writeUInt16LE(0, 36);         // Internal attrs
    cdr.writeUInt32LE(0, 38);         // External attrs
    cdr.writeUInt32LE(localOffset, 42);
    nameBuf.copy(cdr, 46);
    cdRecords.push(cdr);
  }

  const beforeCd = Buffer.concat(localHeaders);
  const cd = Buffer.concat(cdRecords);

  // Build EOCD with original CD offset for APK Signature Scheme v2 digest calculation
  const eocdForDigest = Buffer.alloc(22);
  eocdForDigest.writeUInt32LE(0x06054b50, 0);
  eocdForDigest.writeUInt16LE(0, 4);
  eocdForDigest.writeUInt16LE(0, 6);
  eocdForDigest.writeUInt16LE(allEntries.length, 8);
  eocdForDigest.writeUInt16LE(allEntries.length, 10);
  eocdForDigest.writeUInt32LE(cd.length, 12);
  eocdForDigest.writeUInt32LE(beforeCd.length, 16);
  eocdForDigest.writeUInt16LE(0, 20);

  // Build APK Signature Scheme v2 Block and insert right before Central Directory
  const sigBlockV2 = buildApkSigBlockV2(beforeCd, cd, eocdForDigest, certInfo);

  const finalEocd = Buffer.from(eocdForDigest);
  finalEocd.writeUInt32LE(beforeCd.length + sigBlockV2.length, 16);

  return Buffer.concat([beforeCd, sigBlockV2, cd, finalEocd]);
}

// ============================================================================
// 6. Main Entry Point
// ============================================================================
const ROOT = process.cwd();
const outDir = path.join(ROOT, 'downloads');
fs.mkdirSync(outDir, { recursive: true });

const manifestBin = buildBinaryManifest();
const resourcesArsc = buildResourcesArsc();
const classesDex = buildClassesDex();
const icon512 = fs.readFileSync(path.join(ROOT, 'icons/icon-512.png'));
const icon192 = fs.readFileSync(path.join(ROOT, 'icons/icon-192.png'));

const apkEntries = [
  { name: 'AndroidManifest.xml',        data: manifestBin,   store: false },
  { name: 'resources.arsc',             data: resourcesArsc, store: true }, // Must be uncompressed & 4-byte aligned
  { name: 'classes.dex',                data: classesDex,    store: false },
  { name: 'res/drawable/ic_launcher.png', data: icon192,     store: true },
  { name: 'assets/index.html',          data: fs.readFileSync(path.join(ROOT, 'index.html')), store: false },
  { name: 'assets/manifest.json',       data: fs.readFileSync(path.join(ROOT, 'manifest.json')), store: false },
  { name: 'assets/css/style.css',       data: fs.readFileSync(path.join(ROOT, 'css/style.css')), store: false },
  { name: 'assets/js/app.js',           data: fs.readFileSync(path.join(ROOT, 'js/app.js')), store: false },
  { name: 'assets/js/dj-bridge.js',     data: fs.readFileSync(path.join(ROOT, 'js/dj-bridge.js')), store: false },
  { name: 'assets/js/listener-chat-call.js', data: fs.readFileSync(path.join(ROOT, 'js/listener-chat-call.js')), store: false },
  { name: 'assets/icons/icon-192.png',  data: icon192, store: true },
  { name: 'assets/icons/icon-512.png',  data: icon512, store: true },
  { name: 'assets/img/logo-192.png',    data: icon192, store: true },
  { name: 'assets/img/logo-512.png',    data: icon512, store: true },
];

const certInfo = generateSigningKeyAndCert();
const signedApk = buildSignedApk(apkEntries, certInfo);

const outPath = path.join(outDir, 'BethelRadio.apk');
fs.writeFileSync(outPath, signedApk);
console.log(`Built and signed ${outPath} (${signedApk.length.toLocaleString()} bytes)`);

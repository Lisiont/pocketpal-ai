import * as RNFS from '@dr.pogodin/react-native-fs';
import {pick, types, isErrorWithCode, errorCodes} from '@react-native-documents/picker';
import JSZip from 'jszip';
import {XMLParser} from 'fast-xml-parser';

export interface LocalDocument {
  uri: string;
  name: string;
  extension: string;
}

export const pickLocalDocument = async (): Promise<LocalDocument | null> => {
  try {
    const res = await pick({
      type: [types.allFiles],
    });

    if (!res || res.length === 0) {
      return null;
    }

    const file = res[0];
    const name = file.name || 'document';
    const extension = name.includes('.')
      ? name.split('.').pop()!.toLowerCase()
      : '';

    const supported = ['txt', 'md', 'csv', 'docx'];

    if (!supported.includes(extension)) {
      throw new Error(
        '현재 지원 형식은 TXT, MD, CSV, DOCX입니다.',
      );
    }

    return {
      uri: file.uri,
      name,
      extension,
    };
  } catch (err: any) {
    if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) {
      return null;
    }
    throw err;
  }
};

const readPlainText = async (uri: string): Promise<string> => {
  return RNFS.readFile(uri, 'utf8');
};

const readDocx = async (uri: string): Promise<string> => {
  const base64 = await RNFS.readFile(uri, 'base64');

  const zip = await JSZip.loadAsync(base64, {
    base64: true,
  });

  const documentXml = zip.file('word/document.xml');

  if (!documentXml) {
    throw new Error('DOCX 문서 내용을 찾지 못했습니다.');
  }

  const xml = await documentXml.async('string');

  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
  });

  const parsed = parser.parse(xml);

  const textParts: string[] = [];

  const walk = (node: any) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    if ('#text' in node && typeof node['#text'] === 'string') {
      textParts.push(node['#text']);
    }

    Object.values(node).forEach(walk);
  };

  walk(parsed);

  return textParts.join(' ').replace(/\s+/g, ' ').trim();
};

export const readLocalDocument = async (
  file: LocalDocument,
): Promise<string> => {
  switch (file.extension) {
    case 'txt':
    case 'md':
    case 'csv':
      return readPlainText(file.uri);

    case 'docx':
      return readDocx(file.uri);

    default:
      throw new Error('지원하지 않는 문서 형식입니다.');
  }
};

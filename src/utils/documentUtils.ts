import * as RNFS from '@dr.pogodin/react-native-fs';
import {
  pick,
  types,
  isErrorWithCode,
  errorCodes,
} from '@react-native-documents/picker';

import JSZip from 'jszip';
import {XMLParser} from 'fast-xml-parser';
import * as XLSX from 'xlsx';
import {recognizeText} from '@dariyd/react-native-text-recognition';

export interface LocalDocument {
  uri: string;
  name: string;
  extension: string;
}

const SUPPORTED_EXTENSIONS = [
  'txt',
  'md',
  'csv',
  'docx',
  'xls',
  'xlsx',
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'webp',
];

export const pickLocalDocument =
  async (): Promise<LocalDocument | null> => {
    try {
      const res = await pick({
        type: [types.allFiles],
      });

      if (!res || res.length === 0) {
        return null;
      }

      const file = res[0];
      const name = file.name || 'attachment';

      const extension = name.includes('.')
        ? name.split('.').pop()!.toLowerCase()
        : '';

      if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        throw new Error(
          '지원 형식: TXT, MD, CSV, DOCX, XLS, XLSX, PDF, JPG, JPEG, PNG, WEBP',
        );
      }

      return {
        uri: file.uri,
        name,
        extension,
      };
    } catch (err: any) {
      if (
        isErrorWithCode(err) &&
        err.code === errorCodes.OPERATION_CANCELED
      ) {
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

    if (
      '#text' in node &&
      typeof node['#text'] === 'string'
    ) {
      textParts.push(node['#text']);
    }

    Object.values(node).forEach(walk);
  };

  walk(parsed);

  return textParts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const readSpreadsheet = async (
  uri: string,
): Promise<string> => {
  const base64 = await RNFS.readFile(uri, 'base64');

  const workbook = XLSX.read(base64, {
    type: 'base64',
  });

  const parts: string[] = [];

  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return;
    }

    const csv = XLSX.utils.sheet_to_csv(sheet);

    parts.push(
      `[시트: ${sheetName}]\n${csv}`,
    );
  });

  return parts.join('\n\n');
};

const readWithOCR = async (
  file: LocalDocument,
): Promise<string> => {
  const isPdf = file.extension === 'pdf';

  const result = await recognizeText(
    file.uri,
    isPdf
      ? {
          languages: ['ko', 'en'],
          recognitionLevel: 'line',
          maxPages: 20,
          pdfDpi: 300,
          preprocessImages: false,
        }
      : {
          languages: ['ko', 'en'],
          recognitionLevel: 'line',
          useFastRecognition: false,
        },
  );

  if (!result.success) {
    throw new Error(
      result.errorMessage ||
        'OCR 처리에 실패했습니다.',
    );
  }

  if (result.pages && result.pages.length > 0) {
    return result.pages
      .map(
        page =>
          `[페이지 ${page.pageNumber + 1}]\n${page.fullText || ''}`,
      )
      .join('\n\n')
      .trim();
  }

  if (result.fullText) {
    return result.fullText.trim();
  }

  throw new Error(
    '파일에서 읽을 수 있는 텍스트를 찾지 못했습니다.',
  );
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

    case 'xls':
    case 'xlsx':
      return readSpreadsheet(file.uri);

    case 'pdf':
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'webp':
      return readWithOCR(file);

    default:
      throw new Error(
        '지원하지 않는 파일 형식입니다.',
      );
  }
};

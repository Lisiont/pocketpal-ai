export interface DocumentChunk {
  id: string;
  source: string;
  index: number;
  page?: number;
  text: string;
}

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;

const SUMMARY_WORDS = [
  '요약',
  '정리',
  '핵심',
  '전체',
  '개요',
  'summary',
  'summarize',
  'overview',
];

const tokenize = (text: string): string[] => {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(word => word.trim())
    .filter(word => word.length >= 2);
};

const splitText = (
  text: string,
  source: string,
  page?: number,
  startIndex = 0,
): DocumentChunk[] => {
  const clean = text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!clean) {
    return [];
  }

  const chunks: DocumentChunk[] = [];

  let start = 0;
  let index = startIndex;

  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);

    // Prefer ending at a paragraph or sentence boundary.
    if (end < clean.length) {
      const candidate = clean.slice(start, end);

      const paragraphBreak = candidate.lastIndexOf('\n\n');
      const sentenceBreak = Math.max(
        candidate.lastIndexOf('. '),
        candidate.lastIndexOf('다. '),
        candidate.lastIndexOf('? '),
        candidate.lastIndexOf('! '),
      );

      const boundary = Math.max(paragraphBreak, sentenceBreak);

      if (boundary > CHUNK_SIZE * 0.55) {
        end = start + boundary + 1;
      }
    }

    const chunkText = clean.slice(start, end).trim();

    if (chunkText) {
      chunks.push({
        id: `${source}-${page ?? 'na'}-${index}`,
        source,
        index,
        page,
        text: chunkText,
      });

      index += 1;
    }

    if (end >= clean.length) {
      break;
    }

    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }

  return chunks;
};

export const chunkDocument = (
  content: string,
  source: string,
): DocumentChunk[] => {
  // documentUtils adds [페이지 N] markers for PDF OCR.
  const pageRegex = /\[페이지\s+(\d+)\]\s*\n/g;
  const matches = [...content.matchAll(pageRegex)];

  if (matches.length === 0) {
    return splitText(content, source);
  }

  const chunks: DocumentChunk[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    const page = Number(match[1]);

    const bodyStart =
      (match.index ?? 0) + match[0].length;

    const bodyEnd =
      i + 1 < matches.length
        ? (matches[i + 1].index ?? content.length)
        : content.length;

    const pageText = content.slice(bodyStart, bodyEnd);

    const pageChunks = splitText(
      pageText,
      source,
      page,
      chunkIndex,
    );

    chunks.push(...pageChunks);
    chunkIndex += pageChunks.length;
  }

  return chunks;
};

const isSummaryQuery = (query: string): boolean => {
  const lower = query.toLowerCase();

  return SUMMARY_WORDS.some(word =>
    lower.includes(word),
  );
};

const scoreChunk = (
  queryTokens: string[],
  chunk: DocumentChunk,
): number => {
  const chunkTokens = tokenize(chunk.text);
  const chunkSet = new Set(chunkTokens);

  let score = 0;

  for (const token of queryTokens) {
    if (chunkSet.has(token)) {
      score += 3;
    }

    const occurrences = chunkTokens.filter(
      word => word === token,
    ).length;

    score += Math.min(occurrences, 4);
  }

  return score;
};

const selectSpreadChunks = (
  chunks: DocumentChunk[],
  count: number,
): DocumentChunk[] => {
  if (chunks.length <= count) {
    return chunks;
  }

  if (count <= 1) {
    return [chunks[0]];
  }

  const indexes = new Set<number>();

  for (let i = 0; i < count; i++) {
    indexes.add(
      Math.round(
        (i * (chunks.length - 1)) / (count - 1),
      ),
    );
  }

  return [...indexes]
    .sort((a, b) => a - b)
    .map(index => chunks[index]);
};

export const selectRelevantChunks = (
  query: string,
  chunks: DocumentChunk[],
  maxChunks = 3,
  maxChars = 2400,
): DocumentChunk[] => {
  if (chunks.length === 0) {
    return [];
  }

  let candidates: DocumentChunk[];

  if (isSummaryQuery(query)) {
    // For whole-document summaries, sample across the document.
    candidates = selectSpreadChunks(
      chunks,
      Math.min(maxChunks, chunks.length),
    );
  } else {
    const queryTokens = tokenize(query);

    const ranked = chunks
      .map(chunk => ({
        chunk,
        score: scoreChunk(queryTokens, chunk),
      }))
      .sort((a, b) => b.score - a.score);

    const hasUsefulMatch =
      ranked.length > 0 && ranked[0].score > 0;

    candidates = hasUsefulMatch
      ? ranked
          .slice(0, maxChunks)
          .map(item => item.chunk)
      : selectSpreadChunks(
          chunks,
          Math.min(maxChunks, chunks.length),
        );
  }

  const selected: DocumentChunk[] = [];
  let usedChars = 0;

  for (const chunk of candidates) {
    const remaining = maxChars - usedChars;

    if (remaining <= 0) {
      break;
    }

    if (chunk.text.length <= remaining) {
      selected.push(chunk);
      usedChars += chunk.text.length;
    } else if (remaining >= 300) {
      selected.push({
        ...chunk,
        text:
          chunk.text.slice(0, remaining) +
          '\n[조각 일부 생략]',
      });

      break;
    }
  }

  return selected;
};

export const buildRagContext = (
  chunks: DocumentChunk[],
): string => {
  if (chunks.length === 0) {
    return '';
  }

  const evidence = chunks
    .map((chunk, index) => {
      const location =
        chunk.page !== undefined
          ? `${chunk.source}, p.${chunk.page}`
          : `${chunk.source}, chunk ${chunk.index + 1}`;

      return (
        `[근거 ${index + 1}]\n` +
        `출처: ${location}\n` +
        `[원문 시작]\n` +
        chunk.text +
        `\n[원문 끝]`
      );
    })
    .join('\n\n');

  return (
    `[문서 근거 시작]\n\n` +
    evidence +
    `\n\n[문서 근거 끝]\n\n` +
    `[문서 답변 규칙]\n` +
    `1. 위의 문서 근거에 명시된 내용만 사용하세요.\n` +
    `2. 근거에 없는 정의, 목적, 원인, 의미 또는 기술적 설명을 추측하지 마세요.\n` +
    `3. 일반 지식이나 사전 학습 지식으로 문서 내용을 보충하지 마세요.\n` +
    `4. 근거만으로 확인할 수 없는 내용은 "제공된 문서 근거에서 확인할 수 없습니다."라고 답하세요.\n` +
    `5. 핵심 주장에는 가능한 경우 [p.N] 형식으로 실제 문서 페이지를 표시하세요.\n` +
    `6. "근거 1", "근거 2" 같은 내부 번호를 페이지 번호처럼 표현하지 마세요.\n` +
    `7. 원문이 불완전하거나 OCR 오류로 보이면 임의로 복원하지 말고 불확실하다고 밝히세요.`
  );
};

export const isDocumentSummaryQuery = (
  query: string,
): boolean => {
  return isSummaryQuery(query);
};

const compressChunkLocally = (
  chunk: DocumentChunk,
  maxChars = 320,
): DocumentChunk => {
  const sentences = chunk.text
    .split(/(?<=[.!?]|다\.)\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return {
      ...chunk,
      text: chunk.text.slice(0, maxChars),
    };
  }

  let result = '';

  for (const sentence of sentences) {
    if ((result + ' ' + sentence).trim().length > maxChars) {
      break;
    }

    result = (result + ' ' + sentence).trim();
  }

  if (!result) {
    result = chunk.text.slice(0, maxChars);
  }

  return {
    ...chunk,
    text: result,
  };
};

export const selectSummaryChunksMobile = (
  chunks: DocumentChunk[],
  maxChunks = 7,
  maxChars = 2400,
): DocumentChunk[] => {
  if (chunks.length === 0) {
    return [];
  }

  const spread = selectSpreadChunks(
    chunks,
    Math.min(maxChunks, chunks.length),
  );

  const compressed = spread.map(chunk =>
    compressChunkLocally(chunk, 320),
  );

  const selected: DocumentChunk[] = [];
  let usedChars = 0;

  for (const chunk of compressed) {
    const remaining = maxChars - usedChars;

    if (remaining <= 0) {
      break;
    }

    if (chunk.text.length <= remaining) {
      selected.push(chunk);
      usedChars += chunk.text.length;
    } else if (remaining >= 200) {
      selected.push({
        ...chunk,
        text:
          chunk.text.slice(0, remaining) +
          '\n[일부 생략]',
      });
      break;
    }
  }

  return selected;
};

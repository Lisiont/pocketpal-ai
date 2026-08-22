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

const extractTechnicalIdentifiers = (
  text: string,
): string[] => {
  const normalized = text
    .toLowerCase()
    .replace(/[‐-‒–—−]/g, '-');

  const matches =
    normalized.match(
      /\b(?:[a-z]{1,10}-?\d+(?:[-.]\d+)*|\d+(?:\.\d+){1,4})\b/gi,
    ) ?? [];

  return [...new Set(matches.map(item => item.toLowerCase()))];
};

const compactIdentifier = (value: string): string => {
  return value.toLowerCase().replace(/[-.\s]/g, '');
};

const hasTechnicalIdentifier = (
  text: string,
  identifier: string,
): boolean => {
  const compactTarget = compactIdentifier(identifier);

  if (compactTarget.length < 3) {
    return false;
  }

  return extractTechnicalIdentifiers(text).some(
    item => compactIdentifier(item) === compactTarget,
  );
};

const looksLikeTableOfContents = (
  text: string,
): boolean => {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return false;
  }

  // 예:
  // E-15 Reverse polarity ........ 55
  // 5.15 Reverse polarity ........ 55
  const dottedPageLines = lines.filter(line =>
    /\.{3,}\s*\d+\s*$/.test(line),
  ).length;

  if (dottedPageLines >= 1) {
    return true;
  }

  // PDF 추출 과정에서 점선이 사라지는 경우도 대비.
  // 여러 줄이 제목 + 마지막 페이지 번호 형태면
  // 목차일 가능성이 높음.
  const trailingPageLines = lines.filter(line =>
    /\S.+\s\d{1,4}\s*$/.test(line),
  ).length;

  if (
    lines.length >= 4 &&
    trailingPageLines / lines.length >= 0.5
  ) {
    return true;
  }

  return false;
};

const extractTocTarget = (
  chunk: DocumentChunk,
  identifier: string,
): {title: string; page?: number} | null => {
  const lines = chunk.text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const compactTarget = compactIdentifier(identifier);

  for (const line of lines) {
    if (!hasTechnicalIdentifier(line, identifier)) {
      continue;
    }

    const normalized = line
      .replace(/[‐-‒–—−]/g, '-')
      .replace(/\.{3,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const pageMatch = normalized.match(/\s(\d{1,4})\s*$/);
    const page = pageMatch ? Number(pageMatch[1]) : undefined;

    const withoutPage = pageMatch
      ? normalized.slice(0, pageMatch.index).trim()
      : normalized;

    const idPattern = new RegExp(
      identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    );

    let title = withoutPage.replace(idPattern, '').trim();

    if (!title) {
      const tokens = withoutPage.split(/\s+/);
      const filtered = tokens.filter(
        token => compactIdentifier(token) !== compactTarget,
      );
      title = filtered.join(' ').trim();
    }

    if (title) {
      return {title, page};
    }
  }

  return null;
};

const findBodyFromToc = (
  tocChunk: DocumentChunk,
  identifier: string,
  allChunks: DocumentChunk[],
): DocumentChunk | null => {
  const target = extractTocTarget(
    tocChunk,
    identifier,
  );

  if (!target) {
    return null;
  }

  const normalizedTitle = target.title.toLowerCase();

  const nearby = target.page !== undefined
    ? allChunks.filter(chunk =>
        chunk.page !== undefined &&
        Math.abs(chunk.page - target.page!) <= 4,
      )
    : allChunks;

  const candidates = nearby
    .filter(chunk => !looksLikeTableOfContents(chunk.text))
    .map(chunk => {
      const lower = chunk.text.toLowerCase();

      let score = technicalEvidenceQuality(chunk);

      if (
        normalizedTitle.length >= 4 &&
        lower.includes(normalizedTitle)
      ) {
        score += 120;
      }

      if (hasTechnicalIdentifier(chunk.text, identifier)) {
        score += 40;
      }

      if (
        target.page !== undefined &&
        chunk.page !== undefined
      ) {
        score -= Math.abs(chunk.page - target.page) * 5;
      }

      return {chunk, score};
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.score > 0
    ? candidates[0].chunk
    : null;
};

const technicalEvidenceQuality = (
  chunk: DocumentChunk,
): number => {
  const text = chunk.text.trim();
  const identifiers = extractTechnicalIdentifiers(text);

  let score = 0;

  // 본문처럼 충분한 설명이 있는 청크 우대
  if (text.length >= 600) {
    score += 30;
  } else if (text.length >= 350) {
    score += 20;
  } else if (text.length >= 180) {
    score += 5;
  } else {
    score -= 20;
  }

  // 문장형 설명이 있을수록 본문일 가능성 증가
  const sentenceMarks =
    text.match(/[.!?]/g)?.length ?? 0;

  score += Math.min(sentenceMarks * 2, 16);

  // 한 청크에 기술 식별자가 지나치게 많으면
  // 목차/색인일 가능성이 있으므로 감점
  if (identifiers.length >= 5) {
    score -= Math.min(
      45,
      (identifiers.length - 4) * 7,
    );
  }

  // 점선 + 페이지 번호 형태의 전형적인 목차 감점
  if (/\.{3,}\s*\d+/m.test(text)) {
    score -= 40;
  }

  return score;
};

export const selectExactTechnicalEvidence = (
  query: string,
  chunks: DocumentChunk[],
  maxChunks = 2,
): DocumentChunk[] => {
  const identifiers = extractTechnicalIdentifiers(query);

  if (identifiers.length === 0) {
    return [];
  }

  const selected: DocumentChunk[] = [];
  const seen = new Set<string>();

  for (const identifier of identifiers) {
    const candidates = chunks
      .filter(chunk =>
        hasTechnicalIdentifier(
          chunk.text,
          identifier,
        ),
      )
      .map(chunk => ({
        chunk,
        isToc:
          looksLikeTableOfContents(chunk.text),
        quality:
          technicalEvidenceQuality(chunk),
      }))
      .sort((a, b) => {
        if (a.isToc !== b.isToc) {
          return a.isToc ? 1 : -1;
        }

        return b.quality - a.quality;
      });

    let best = candidates[0]?.chunk;

    // 식별자가 목차에서만 잡히는 경우:
    // 목차의 제목/페이지 정보를 이용해 실제 본문으로 재탐색
    if (
      best &&
      looksLikeTableOfContents(best.text)
    ) {
      const redirected = findBodyFromToc(
        best,
        identifier,
        chunks,
      );

      if (redirected) {
        best = redirected;
      }
    }

    if (best && !seen.has(best.id)) {
      seen.add(best.id);
      selected.push(best);
    }

    if (selected.length >= maxChunks) {
      break;
    }
  }

  return selected;
};

export const isSimpleTechnicalLookup = (
  query: string,
): boolean => {
  const identifiers = extractTechnicalIdentifiers(query);

  if (identifiers.length === 0) {
    return false;
  }

  const lower = query.toLowerCase();

  const complexWords = [
    '비교',
    '차이',
    '분석',
    '영향',
    '평가',
    '장단점',
    '왜',
    '원인',
    'compare',
    'difference',
    'analyze',
    'impact',
    'evaluate',
    'why',
  ];

  if (complexWords.some(word => lower.includes(word))) {
    return false;
  }

  const lookupWords = [
    '뭐',
    '무엇',
    '설명',
    '알려',
    '내용',
    '어디',
    '페이지',
    '찾아',
    '시험',
    '항목',
    'what',
    'describe',
    'where',
    'find',
  ];

  return lookupWords.some(word => lower.includes(word));
};

export const buildFastEvidenceResponse = (
  query: string,
  evidence: DocumentChunk[],
): string | null => {
  const identifiers =
    extractTechnicalIdentifiers(query);

  if (
    identifiers.length === 0 ||
    evidence.length === 0
  ) {
    return null;
  }

  const lower = query.toLowerCase();

  const comparisonWords = [
    '비교',
    '차이',
    '분석',
    'compare',
    'difference',
    'analyze',
  ];

  const isComparison =
    identifiers.length >= 2 &&
    comparisonWords.some(word =>
      lower.includes(word),
    );

  if (isComparison) {
    const names = identifiers
      .map(item => item.toUpperCase())
      .join(' / ');

    return (
      `문서에서 ${names} 항목의 본문 근거를 각각 찾았습니다.\n\n` +
      `아래의 '사용된 문서 근거' 카드에서 ` +
      `각 항목의 실제 원문과 페이지를 확인할 수 있습니다.\n\n` +
      `현재 로컬 빠른 모드에서는 문서에 없는 의미를 ` +
      `임의로 추론하지 않기 위해 자동 비교 해석은 생략했습니다.`
    );
  }

  if (!isSimpleTechnicalLookup(query)) {
    return null;
  }

  const identifier =
    identifiers[0].toUpperCase();

  const first = evidence[0];

  const location =
    first.page !== undefined
      ? `${first.source} · p.${first.page}`
      : first.source;

  return (
    `문서에서 ${identifier} 항목을 찾았습니다.\n\n` +
    `${location}\n\n` +
    `아래의 '사용된 문서 근거' 카드에서 ` +
    `실제로 검색된 원문을 확인할 수 있습니다.\n` +
    `원문에 명시되지 않은 의미나 목적은 자동으로 추론하지 않았습니다.`
  );
};

const scoreChunk = (
  queryTokens: string[],
  queryIdentifiers: string[],
  chunk: DocumentChunk,
): number => {
  const chunkTokens = tokenize(chunk.text);
  const chunkSet = new Set(chunkTokens);

  let score = 0;

  for (const identifier of queryIdentifiers) {
    if (hasTechnicalIdentifier(chunk.text, identifier)) {
      score += 100;
    }
  }

  for (const token of queryTokens) {
    if (chunkSet.has(token)) {
      score += 3;
    }

    const occurrences = chunkTokens.filter(
      word => word === token,
    ).length;

    score += Math.min(occurrences, 4);
  }

  score += technicalEvidenceQuality(chunk);

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
    const queryIdentifiers =
      extractTechnicalIdentifiers(query);

    const ranked = chunks
      .map(chunk => ({
        chunk,
        score: scoreChunk(
          queryTokens,
          queryIdentifiers,
          chunk,
        ),
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

    console.log(
      '[RAG] query:',
      query,
      'identifiers:',
      queryIdentifiers,
      'selected:',
      candidates.map(chunk => ({
        source: chunk.source,
        page: chunk.page,
        index: chunk.index,
        preview: chunk.text.slice(0, 120),
      })),
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
    `[답변 규칙]\n` +
    `1. SOURCE에 직접 적혀 있는 사실만 답하세요.\n` +
    `2. SOURCE에 없는 목적, 조건, 원인, 의미를 추론하거나 일반 지식으로 보충하지 마세요.\n` +
    `3. 질문한 항목 중 확인되지 않는 부분만 "문서 근거에서 확인되지 않음"이라고 표시하세요.\n` +
    `4. 답변 끝에 별도의 근거·출처·참고 목록이나 확인 불가 문장을 추가하지 마세요.`
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

export const expandWithAdjacentChunks = (
  selected: DocumentChunk[],
  allChunks: DocumentChunk[],
  maxChars = 2600,
): DocumentChunk[] => {
  if (selected.length === 0) {
    return [];
  }

  const candidates: DocumentChunk[] = [];
  const seen = new Set<string>();

  const add = (chunk?: DocumentChunk) => {
    if (!chunk || seen.has(chunk.id)) {
      return;
    }

    seen.add(chunk.id);
    candidates.push(chunk);
  };

  for (const target of selected) {
    const position = allChunks.findIndex(
      chunk => chunk.id === target.id,
    );

    if (position === -1) {
      add(target);
      continue;
    }

    // 정확히 검색된 청크를 우선하고 앞/뒤 문맥을 추가
    add(allChunks[position]);
    add(allChunks[position + 1]);
    add(allChunks[position - 1]);
  }

  const result: DocumentChunk[] = [];
  let usedChars = 0;

  for (const chunk of candidates) {
    const remaining = maxChars - usedChars;

    if (remaining <= 0) {
      break;
    }

    if (chunk.text.length <= remaining) {
      result.push(chunk);
      usedChars += chunk.text.length;
    } else if (remaining >= 300) {
      result.push({
        ...chunk,
        text:
          chunk.text.slice(0, remaining) +
          '\n[문맥 일부 생략]',
      });
      break;
    }
  }

  return result;
};

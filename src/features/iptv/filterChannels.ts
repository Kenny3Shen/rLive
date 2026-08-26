import type { IptvChannel } from "./types";

export type IptvGroupOption = {
  value: string;
  count: number;
};

export type IptvChannelFilter = {
  group: string;
  query: string;
};

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function searchTerms(query: string): string[] {
  return [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
}

function channelGroups(group: string): string[] {
  const labels = group
    .split(";")
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.length === 0) return ["未分组"];

  const unique = new Map<string, string>();
  for (const label of labels) {
    unique.set(normalize(label), label);
  }
  return [...unique.values()];
}

function termScore(name: string, groups: readonly string[], term: string): number | null {
  if (name === term) return 0;
  if (name.startsWith(term)) return 1;
  if (groups.some((group) => group === term)) return 2;
  if (groups.some((group) => group.startsWith(term))) return 3;
  if (name.includes(term)) return 4;
  if (groups.some((group) => group.includes(term))) return 5;
  return null;
}

/** 分类选项只构建一次，按观众最常使用的分组排序。 */
export function getIptvGroupOptions(channels: readonly IptvChannel[]): IptvGroupOption[] {
  const counts = new Map<string, IptvGroupOption>();
  for (const channel of channels) {
    for (const group of channelGroups(channel.group)) {
      const key = normalize(group);
      const current = counts.get(key);
      if (current) {
        current.count += 1;
      } else {
        counts.set(key, { value: group, count: 1 });
      }
    }
  }

  return [...counts.values()].sort((a, b) => {
    const countDifference = b.count - a.count;
    return countDifference !== 0 ? countDifference : a.value.localeCompare(b.value, "zh-Hans-CN");
  });
}

/**
 * 把每个以空白分隔的关键字与频道名或分组匹配。精确与前缀匹配排在宽松子串
 * 匹配之前；空搜索保留上游播放列表精心编排的顺序。
 */
export function filterIptvChannels(
  channels: readonly IptvChannel[],
  { group, query }: IptvChannelFilter,
): IptvChannel[] {
  const terms = searchTerms(query);
  const normalizedGroup = normalize(group);
  const matches: { channel: IptvChannel; score: number; index: number }[] = [];

  channels.forEach((channel, index) => {
    const groups = channelGroups(channel.group).map(normalize);
    if (group !== "all" && !groups.includes(normalizedGroup)) return;

    const name = normalize(channel.name);
    let score = 0;
    for (const term of terms) {
      const matchScore = termScore(name, groups, term);
      if (matchScore === null) return;
      score += matchScore;
    }
    matches.push({ channel, score, index });
  });

  if (terms.length > 0) {
    matches.sort((a, b) => a.score - b.score || a.index - b.index);
  }
  return matches.map(({ channel }) => channel);
}

type EncodingPreference = {
  name: string;
  quality: number;
  token: string;
};

function parseEncodingPreference(token: string): EncodingPreference | null {
  const parts = token.split(";").map((part) => part.trim());
  const name = parts.shift()?.toLowerCase();
  if (!name || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)) {
    return null;
  }
  let quality = 1;
  for (const parameter of parts) {
    const match = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.exec(parameter);
    if (match === null) {
      return null;
    }
    quality = Number(match[1]);
  }
  return { name, quality, token: token.trim() };
}

export function preferBrotliAcceptEncoding(value: string): string {
  if (value.length === 0 || value.length > 1024) {
    return value;
  }
  const preferences = value.split(",").map(parseEncodingPreference);
  if (preferences.some((entry) => entry === null)) {
    return value;
  }
  const entries = preferences as EncodingPreference[];
  const brotli = entries.filter((entry) => entry.name === "br");
  const gzip = entries.filter((entry) => entry.name === "gzip");
  const brotliEntry = brotli[0];
  const gzipEntry = gzip[0];
  if (
    brotli.length !== 1 ||
    gzip.length !== 1 ||
    brotliEntry === undefined ||
    gzipEntry === undefined ||
    brotliEntry.quality === 0 ||
    brotliEntry.quality < gzipEntry.quality
  ) {
    return value;
  }
  const brotliIndex = entries.indexOf(brotliEntry);
  const gzipIndex = entries.indexOf(gzipEntry);
  if (brotliIndex < gzipIndex) {
    return value;
  }
  return [brotliEntry, ...entries.filter((entry) => entry !== brotliEntry)]
    .map((entry) => entry.token)
    .join(", ");
}

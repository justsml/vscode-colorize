import { readFileSync, statSync } from 'fs';

// Default file size limit: 1MB
const DEFAULT_FILE_SIZE_LIMIT = 1024 * 1024;

/**
 * Checks if a file exceeds the size limit
 * @param fileName Path to the file
 * @param sizeLimit Size limit in bytes (defaults to 1MB)
 * @returns true if file size is within limit, false otherwise
 */
export function isFileSizeWithinLimit(fileName: string, sizeLimit = DEFAULT_FILE_SIZE_LIMIT): boolean {
  try {
    const stats = statSync(fileName);
    return stats.size <= sizeLimit;
  } catch (error) {
    console.error(`Error checking file size for ${fileName}:`, error);
    return false;
  }
}

/**
 * Extracts content from a file with size limit protection
 * @param fileName Path to the file
 * @param sizeLimit Size limit in bytes (defaults to 1MB)
 * @returns Array of line objects with text and line number
 * @throws Error if file exceeds size limit
 */
export function extractFileContent(fileName: string, sizeLimit = DEFAULT_FILE_SIZE_LIMIT) {
  // Check file size before reading
  if (!isFileSizeWithinLimit(fileName, sizeLimit)) {
    throw new Error(`File size exceeds limit (${sizeLimit} bytes): ${fileName}`);
  }
  
  const text = readFileSync(fileName, 'utf8');
  return text.split(/\n/).map((text, index) => ({
    text: text,
    line: index,
  }));
}

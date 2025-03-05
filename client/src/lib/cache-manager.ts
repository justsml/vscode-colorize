import type { IDecoration } from './util/color-util';
import type { TextDocument } from 'vscode';

class CacheManager {
  private _dirtyCache: Map<string, Map<number, IDecoration[]>>;
  private _decorationsCache: Map<string, Map<number, IDecoration[]>>;
  private _dirtyCacheLRU: string[] = [];
  private _decorationsCacheLRU: string[] = [];
  private readonly MAX_CACHE_SIZE = 100; // Maximum number of files to cache

  constructor() {
    this._dirtyCache = new Map();
    this._decorationsCache = new Map();
  }

  /**
   * Return the saved decorations for a document or return null if the file has never been opened before.
   *
   * @param {TextEditor} editor
   * @returns {(Map<number, IDecoration[]> | null)}
   */
  public getCachedDecorations(document: TextDocument) {
    const fileName = document.fileName;
    
    if (!document.isDirty && this._decorationsCache.has(fileName)) {
      // Update LRU order for decorations cache
      this._updateLRU(this._decorationsCacheLRU, fileName);
      return this._decorationsCache.get(fileName);
    }
    
    if (this._dirtyCache.has(fileName)) {
      // Update LRU order for dirty cache
      this._updateLRU(this._dirtyCacheLRU, fileName);
      return this._dirtyCache.get(fileName);
    }
    
    return undefined;
  }
  
  /**
   * Update the LRU order for a cache
   *
   * @param {string[]} lruArray The LRU tracking array to update
   * @param {string} fileName The file name to update in the LRU
   */
  private _updateLRU(lruArray: string[], fileName: string) {
    // Remove if exists
    const index = lruArray.indexOf(fileName);
    if (index !== -1) {
      lruArray.splice(index, 1);
    }
    // Add to end (most recently used)
    lruArray.push(fileName);
  }
  /**
   * Save a file decorations
   *
   * @param {TextDocument} document
   * @param {Map<number, IDecoration[]>} deco
   */
  public saveDecorations(
    document: TextDocument,
    deco: Map<number, IDecoration[]>,
  ) {
    if (document.isDirty) {
      this._saveDirtyDecoration(document.fileName, deco);
    } else {
      this._saveSavedDecorations(document.fileName, deco);
    }
  }

  private _saveDirtyDecoration(
    fileName: string,
    decorations: Map<number, IDecoration[]>,
  ) {
    // Enforce cache size limit with LRU eviction
    if (this._dirtyCache.size >= this.MAX_CACHE_SIZE && !this._dirtyCache.has(fileName)) {
      // Remove least recently used item
      if (this._dirtyCacheLRU.length > 0) {
        const lruFile = this._dirtyCacheLRU.shift();
        if (lruFile) {
          this._dirtyCache.delete(lruFile);
        }
      }
    }
    
    // Update LRU tracking
    this._updateLRU(this._dirtyCacheLRU, fileName);
    
    return this._dirtyCache.set(fileName, decorations);
  }

  private _saveSavedDecorations(
    fileName: string,
    decorations: Map<number, IDecoration[]>,
  ) {
    // Enforce cache size limit with LRU eviction
    if (this._decorationsCache.size >= this.MAX_CACHE_SIZE && !this._decorationsCache.has(fileName)) {
      // Remove least recently used item
      if (this._decorationsCacheLRU.length > 0) {
        const lruFile = this._decorationsCacheLRU.shift();
        if (lruFile) {
          this._decorationsCache.delete(lruFile);
        }
      }
    }
    
    // Update LRU tracking
    this._updateLRU(this._decorationsCacheLRU, fileName);
    
    return this._decorationsCache.set(fileName, decorations);
  }

  public clearCache() {
    this._dirtyCache.clear();
    this._decorationsCache.clear();
    // Also clear the LRU tracking arrays
    this._dirtyCacheLRU.length = 0;
    this._decorationsCacheLRU.length = 0;
  }
}

const instance = new CacheManager();

export default instance;

'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import type {
  ExtensionContext,
  TextEditor,
  TextDocument,
  TextEditorSelectionChangeEvent,
  Selection,
  Range,
  StatusBarItem,
} from 'vscode';
import { window, workspace, StatusBarAlignment, ThemeColor } from 'vscode';
import type {
  IDecoration,
  DocumentLine,
  LineExtraction,
} from './lib/util/color-util';
import ColorUtil from './lib/util/color-util';
import Queue from './lib/queue';
import VariablesManager from './lib/variables/variables-manager';
import CacheManager from './lib/cache-manager';
import EditorManager from './lib/editor-manager';
import type { ColorizeConfig } from './lib/colorize-config';
import {
  getColorizeConfig,
  generateDecorationType,
} from './lib/colorize-config';
import { RateLimiter, debounce } from './lib/util/rate-limiter';

import Listeners from './listeners';
import { minimatch } from 'minimatch';
import type Variable from './lib/variables/variable';

// Define interfaces for server response
interface ExtractVariablesError {
  fileName?: string;
  error: string;
}

interface ExtractVariablesResponse {
  filesContent: Array<{ fileName: string; content: DocumentLine[] }>;
  errors?: ExtractVariablesError[];
}

import type {
  LanguageClientOptions,
  ServerOptions,
} from 'vscode-languageclient/node';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import path from 'path';

let client: LanguageClient;
let config: ColorizeConfig = {
  languages: [],
  isHideCurrentLineDecorations: true,
  colorizedVariables: [],
  colorizedColors: [],
  filesToExcludes: [],
  filesToIncludes: [],
  inferredFilesToInclude: [],
  searchVariables: false,
  fileSizeLimit: 1024 * 1024, // Default to 1MB
  variablesExtractionDelay: 1000, // Default to 1000ms
  colorizeDelay: 300, // Default to 300ms
  selectionChangeDelay: 100, // Default to 100ms
  decorationDelay: 500, // Default to 500ms
  decorationFn: generateDecorationType(),
};
class ColorizeContext {
  editor: TextEditor | undefined = undefined;
  nbLine: number | null = 0;
  deco: Map<number, IDecoration[]> = new Map();
  currentSelection: number[] | null = null;
  statusBar: StatusBarItem;
  serverPath: string;
  
  // Rate limiters for frequently triggered operations
  variablesExtractionLimiter: RateLimiter;
  colorizeLimiter: RateLimiter;
  selectionChangeLimiter: RateLimiter;
  decorationLimiter: RateLimiter;

  constructor(serverPath: string) {
    this.statusBar = window.createStatusBarItem(StatusBarAlignment.Right);
    this.serverPath = serverPath;
    
    // Initialize rate limiters with default values
    // These will be updated when config is loaded
    this.variablesExtractionLimiter = new RateLimiter(1000);
    this.colorizeLimiter = new RateLimiter(300);
    this.selectionChangeLimiter = new RateLimiter(100);
    this.decorationLimiter = new RateLimiter(500);
  }
  
  /**
   * Update rate limiters based on configuration
   * @param config The current configuration
   */
  updateRateLimiters(config: ColorizeConfig) {
    this.variablesExtractionLimiter = new RateLimiter(config.variablesExtractionDelay);
    this.colorizeLimiter = new RateLimiter(config.colorizeDelay);
    this.selectionChangeLimiter = new RateLimiter(config.selectionChangeDelay);
    this.decorationLimiter = new RateLimiter(config.decorationDelay);
  }

  updateStatusBar(activated: boolean) {
    // List of icons can be found here https://code.visualstudio.com/api/references/icons-in-labels
    const icon = activated ? '$(check)' : '$(circle-slash)';
    const hoverMessage = activated
      ? 'Colorize is activated for this file'
      : 'Colorize is not activated for this file';
    this.statusBar.text = `${icon} Colorize`;
    this.statusBar.backgroundColor = new ThemeColor('statusBar.background');
    this.statusBar.color = new ThemeColor('statusBar.foreground');
    this.statusBar.tooltip = hoverMessage;
    this.statusBar.show();
  }
}

const q = new Queue();

async function initDecorations(context: ColorizeContext) {
  // Use rate limiting for decoration initialization to prevent excessive processing
  return context.decorationLimiter.executeAsync(async () => {
    if (!context.editor) {
      return;
    }
    const text = context.editor.document.getText();
    const fileLines: DocumentLine[] = ColorUtil.textToFileLines(text);

    const lines: DocumentLine[] = context.editor.visibleRanges.reduce(
      (acc: DocumentLine[], range: Range) => {
        return [...acc, ...fileLines.slice(range.start.line, range.end.line + 2)];
      },
      [],
    );

    // removeDuplicateDecorations(context);
    await VariablesManager.findVariablesDeclarations(
      context.editor.document.fileName,
      fileLines,
    );

    const variables: LineExtraction[] = await VariablesManager.findVariables(
      context.editor.document.fileName,
      lines,
    );

    const colors: LineExtraction[] = await ColorUtil.findColors(lines);
    generateDecorations(colors, variables, context.deco);

    return EditorManager.decorate(
      context.editor,
      context.deco,
      context.currentSelection ?? [],
    );
  });
}

function updateContextDecorations(
  decorations: Map<number, IDecoration[]>,
  context: ColorizeContext,
) {
  const it = decorations.entries();
  let tmp = it.next();
  while (!tmp.done) {
    const line = tmp.value[0];
    if (context.deco.has(line)) {
      context.deco.set(
        line,
        // @ts-expect-error context.deco.get(line) cannot be undefined here has context.deco.has(line) before
        context.deco.get(line).concat(decorations.get(line)),
      );
    } else {
      context.deco.set(line, decorations.get(line) ?? []);
    }
    tmp = it.next();
  }
}

function removeDuplicateDecorations(context: ColorizeContext) {
  const it = context.deco.entries();
  const m: Map<number, IDecoration[]> = new Map();
  let tmp = it.next();

  while (!tmp.done) {
    const line = tmp.value[0];
    const decorations = tmp.value[1];
    let newDecorations: IDecoration[] = [];
    // TODO; use reduce?
    decorations.forEach((deco) => {
      deco.generateRange(line);
      const exist = newDecorations.findIndex((_) =>
        deco.currentRange.isEqual(_.currentRange),
      );
      if (exist !== -1) {
        newDecorations[exist].dispose();
        newDecorations = newDecorations.filter((_, i) => i !== exist);
      }
      newDecorations.push(deco);
    });
    m.set(line, newDecorations);
    tmp = it.next();
  }
  context.deco = m;
}

function updateDecorationMap(
  map: Map<number, IDecoration[]>,
  line: number,
  decoration: IDecoration,
) {
  if (map.has(line)) {
    // @ts-expect-error map.get(line) cannot be undefined as map.has(line) before
    map.set(line, map.get(line).concat([decoration]));
  } else {
    map.set(line, [decoration]);
  }
}

function generateDecorations(
  colors: LineExtraction[],
  variables: LineExtraction[],
  decorations: Map<number, IDecoration[]>,
) {
  colors.map(({ line, colors }) =>
    colors.forEach((color) => {
      const decoration = ColorUtil.generateDecoration(
        color,
        line,
        config.decorationFn,
      );
      updateDecorationMap(decorations, line, decoration);
    }),
  );
  variables.map(({ line, colors }) =>
    colors.forEach((variable) => {
      const decoration = VariablesManager.generateDecoration(
        <Variable>variable,
        line,
        config.decorationFn,
      );
      updateDecorationMap(decorations, line, decoration);
    }),
  );
  return decorations;
}

/**
 * Check if COLORIZE support a language
 *
 * @param {string} languageId A valid languageId
 * @returns {boolean}
 */
function isLanguageSupported(languageId: string) {
  return config.languages.indexOf(languageId) !== -1;
}

/**
 * Check if the file is the `colorize.include` setting
 *
 * @param {string} fileName A valid filename (path to the file)
 * @returns {boolean}
 */
function isIncludedFile(fileName: string) {
  return config.filesToIncludes.some((globPattern: string) =>
    minimatch(fileName, globPattern, { nonegate: true }),
  );
}

/**
 * Check if the file is the `colorize.exclude` setting
 *
 * @param {string} fileName A valid filename (path to the file)
 * @returns {boolean}
 */
function isExcludedFile(fileName: string) {
  return config.filesToExcludes.some((globPattern: string) =>
    minimatch(fileName, globPattern, { nonegate: true }),
  );
}

/**
 * Check if a file can be colorized by COLORIZE
 *
 * @param {TextDocument} document The document to test
 * @returns {boolean}
 */
function canColorize(document: TextDocument) {
  // update to use filesToExcludes. Remove `isLanguageSupported` ? checking path with file extension or include glob pattern should be enough
  return (
    !isExcludedFile(document.fileName) &&
    (isLanguageSupported(document.languageId) ||
      isIncludedFile(document.fileName))
  );
}

function handleTextSelectionChange(
  event: TextEditorSelectionChangeEvent,
  cb: () => void,
) {
  // Use rate limiting for selection change handling to prevent excessive processing during rapid selection changes
  extension.selectionChangeLimiter.execute(() => {
    if (
      !config.isHideCurrentLineDecorations ||
      event.textEditor !== extension.editor
    ) {
      return cb();
    }

    if (extension.currentSelection) {
      extension.currentSelection.forEach((line) => {
        const decorations = extension.deco.get(line);
        if (decorations !== undefined) {
          EditorManager.decorateOneLine(
            extension.editor as TextEditor, // editor cannot be null here
            decorations,
            line,
          );
        }
      });
    }
    extension.currentSelection = [];
    event.selections.forEach((selection: Selection) => {
      const decorations = extension.deco.get(selection.active.line);
      if (decorations) {
        decorations.forEach((_) => _.hide());
      }
    });
    extension.currentSelection = event.selections.map(
      (selection: Selection) => selection.active.line,
    );
    return cb();
  });
}

function handleCloseOpen(document: TextDocument) {
  q.push((cb) => {
    if (
      extension.editor &&
      extension.editor.document.fileName === document.fileName
    ) {
      CacheManager.saveDecorations(document, extension.deco);
      return cb();
    }
    return cb();
  });
}

async function colorize(editor: TextEditor, cb: () => void) {
  // Use rate limiting for colorization to prevent excessive processing when switching files rapidly
  extension.colorizeLimiter.execute(async () => {
    extension.editor = undefined;
    extension.deco = new Map();
    if (!editor || !canColorize(editor.document)) {
      extension.updateStatusBar(false);
      return cb();
    }
    extension.updateStatusBar(true);
    extension.editor = editor;
    extension.currentSelection = editor.selections.map(
      (selection: Selection) => selection.active.line,
    );
    const deco = CacheManager.getCachedDecorations(editor.document);
    if (deco) {
      extension.deco = deco;
      extension.nbLine = editor.document.lineCount;

      EditorManager.decorate(
        extension.editor,
        extension.deco,
        extension.currentSelection,
      );
    } else {
      extension.nbLine = editor.document.lineCount;
      try {
        await initDecorations(extension);
      } finally {
        if (extension.editor) {
          CacheManager.saveDecorations(extension.editor.document, extension.deco);
        }
      }
    }
    return cb();
  });
}

function handleChangeActiveTextEditor(editor: TextEditor | undefined) {
  if (!editor) {
    return;
  }
  if (extension.editor !== undefined && extension.editor !== null) {
    extension.deco.forEach((decorations) =>
      decorations.forEach((deco) => deco.hide()),
    );
    CacheManager.saveDecorations(extension.editor.document, extension.deco);
  }

  getVisibleFileEditors()
    .filter((e) => e !== editor)
    .forEach((e) => {
      q.push((cb) => colorize(e, cb));
    });

  q.push((cb) => colorize(editor, cb));
}

function cleanDecorationList(context: ColorizeContext, cb: () => void) {
  const it = context.deco.entries();
  let tmp = it.next();
  while (!tmp.done) {
    const line = tmp.value[0];
    const decorations = tmp.value[1];
    context.deco.set(
      line,
      decorations.filter((decoration) => !decoration.disposed),
    );
    tmp = it.next();
  }
  return cb();
}

function clearCache() {
  extension.deco.clear();
  extension.deco = new Map();
  CacheManager.clearCache();
}

function handleConfigurationChanged() {
  const newConfig = getColorizeConfig();
  clearCache();
  // delete current decorations then regenerate decorations
  ColorUtil.setupColorsExtractors(newConfig.colorizedColors);
  
  // Update rate limiters with new configuration values
  extension.updateRateLimiters(newConfig);

  q.push(async (cb) => {
    // remove event listeners?
    VariablesManager.setupVariablesExtractors(newConfig.colorizedVariables);

    if (newConfig.searchVariables && window.activeTextEditor) {
      await triggerVariablesExtraction(window.activeTextEditor.document);
    }
    return cb();
  });
  config = newConfig;
  colorizeVisibleTextEditors();
}

async function triggerVariablesExtraction(textDocument: TextDocument) {
  // Use rate limiting for variable extraction to prevent excessive server requests
  return extension.variablesExtractionLimiter.executeAsync(async () => {
    if (!client) {
      await startServerClient(extension.serverPath);
    }
    const workspaceFolder = workspace.getWorkspaceFolder(textDocument.uri);
    
    try {
      const response = await client.sendRequest<ExtractVariablesResponse>('colorize_extract_variables', {
        rootFolder: workspaceFolder?.uri.fsPath,
        includes: config.filesToIncludes.concat(config.inferredFilesToInclude),
        excludes: config.filesToExcludes,
        fileSizeLimit: config.fileSizeLimit,
      });
      
      // Handle the new response format which includes errors
      if (response.errors && response.errors.length > 0) {
        // Log errors to console
        response.errors.forEach((error) => {
          const errorMessage = error.fileName
            ? `Error processing ${error.fileName}: ${error.error}`
            : `Error: ${error.error}`;
          console.error(errorMessage);
        });
        
        // Show notification for file size limit errors
        const fileSizeLimitErrors = response.errors.filter((e) =>
          e.error.includes('File size exceeds limit'));
        
        if (fileSizeLimitErrors.length > 0) {
          window.showWarningMessage(
            `${fileSizeLimitErrors.length} file(s) exceeded the size limit and were skipped. ` +
            `You can adjust the limit in settings (colorize.fileSizeLimit).`
          );
        }
      }

      // Process the files content that were successfully extracted
      if (response.filesContent && response.filesContent.length > 0) {
        await VariablesManager.getWorkspaceVariables(response.filesContent);
      }
    } catch (error) {
      console.error('Error during variables extraction:', error);
      window.showErrorMessage('Failed to extract color variables. See console for details.');
    }
  });
}

function initEventListeners(context: ExtensionContext) {
  // Use debounced handler for text selection changes to reduce processing frequency
  const debouncedSelectionHandler = debounce((event: TextEditorSelectionChangeEvent) => {
    q.push((cb) => handleTextSelectionChange(event, cb));
  }, config.selectionChangeDelay / 2); // Use half the rate limit delay for debounce
  
  window.onDidChangeTextEditorSelection(
    debouncedSelectionHandler,
    null,
    context.subscriptions,
  );

  // Use debounced handler for document open to prevent multiple extractions
  const debouncedVariablesExtraction = debounce(triggerVariablesExtraction, config.variablesExtractionDelay / 3); // Use 1/3 of the rate limit delay for debounce
  
  workspace.onDidOpenTextDocument(
    debouncedVariablesExtraction,
    null,
    context.subscriptions,
  );
  
  workspace.onDidCloseTextDocument(
    handleCloseOpen,
    null,
    context.subscriptions,
  );
  
  workspace.onDidSaveTextDocument(handleCloseOpen, null, context.subscriptions);
  
  // Use debounced handler for editor changes to prevent rapid processing when switching tabs
  const debouncedEditorChangeHandler = debounce(handleChangeActiveTextEditor, config.colorizeDelay / 3); // Use 1/3 of the rate limit delay for debounce
  
  window.onDidChangeActiveTextEditor(
    debouncedEditorChangeHandler,
    null,
    context.subscriptions,
  );
  
  workspace.onDidChangeConfiguration(
    handleConfigurationChanged,
    null,
    context.subscriptions,
  ); // Does not update when local config file is edited manually ><

  Listeners.setupEventListeners(context);
}

function getVisibleFileEditors() {
  return window.visibleTextEditors.filter(
    (editor) => editor.document.uri.scheme === 'file',
  );
}

function colorizeVisibleTextEditors() {
  extension.nbLine = 65;
  getVisibleFileEditors().forEach((editor) => {
    q.push((cb) => colorize(editor, cb));
  });
}

let extension: ColorizeContext;

export function activate(context: ExtensionContext) {
  extension = new ColorizeContext(
    context.asAbsolutePath(path.join('server', 'out', 'server.js')),
  );
  config = getColorizeConfig();
  
  // Update rate limiters with values from configuration
  extension.updateRateLimiters(config);

  ColorUtil.setupColorsExtractors(config.colorizedColors);
  VariablesManager.setupVariablesExtractors(config.colorizedVariables);

  q.push(async (cb) => {
    try {
      if (config.searchVariables && window.activeTextEditor) {
        await triggerVariablesExtraction(window.activeTextEditor.document);
      }
      initEventListeners(context);
    } catch (error) {
      console.log(error);
    }
    return cb();
  });
  colorizeVisibleTextEditors();
  return extension;
}

function startServerClient(serverModule: string) {
  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', pattern: '**' }],
    // synchronize: {
    //   // Notify the server about file changes to '.clientrc files contained in the workspace
    //   fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
    // },
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'colorizeServer',
    'Colorize Server',
    serverOptions,
    clientOptions,
  );

  // Start the client. This will also launch the server
  return client.start();
}

// this method is called when your extension is deactivated
export function deactivate() {
  extension.nbLine = null;
  extension.editor = undefined;
  extension.deco.clear();
  // extension.deco = null; // needed ?
  CacheManager.clearCache();
}

export {
  canColorize,
  ColorizeContext,
  colorize,
  config,
  extension,
  q,
  updateContextDecorations,
  generateDecorations,
  removeDuplicateDecorations,
  cleanDecorationList,
};

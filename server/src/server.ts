import type {
  InitializeParams,
  InitializeResult,
} from 'vscode-languageserver/node.js';
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  DidChangeConfigurationNotification,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { globbySync } from 'globby';
import { extractFileContent, isFileSizeWithinLimit } from './utils/index.js';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);
// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      // completionProvider: {
      //   resolveProvider: true,
      // },
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined,
    );
  }

  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen

// The example settings
interface ColorizeSettings {
  colorized_variables: string[];
  colorized_colors: string[];
  languages: string[];
  include: string[];
  exclude: string[];
  enable_search_variables: boolean;
  fileSizeLimit: number; // Size limit in bytes, defaults to 1MB
}

// Default settings
const defaultSettings: ColorizeSettings = {
  colorized_variables: [],
  colorized_colors: [],
  languages: [],
  include: [],
  exclude: [],
  enable_search_variables: false,
  fileSizeLimit: 1024 * 1024 // 1MB default
};

// Cache the settings of all open documents with a maximum size limit
const MAX_DOCUMENT_SETTINGS = 100; // Limit the number of cached document settings
const documentSettings: Map<string, Thenable<ColorizeSettings>> = new Map();
// Track LRU order for document settings
const documentSettingsLRU: string[] = [];

async function extractDocumentColors(textDocument: TextDocument) {
  await getDocumentSettings(textDocument.uri);
}

function getDocumentSettings(resource: string) {
  if (!hasConfigurationCapability) {
    return Promise.resolve(defaultSettings);
  }
  
  // Update LRU order - remove if exists and add to end (most recently used)
  const lruIndex = documentSettingsLRU.indexOf(resource);
  if (lruIndex !== -1) {
    documentSettingsLRU.splice(lruIndex, 1);
  }
  documentSettingsLRU.push(resource);
  
  let result = documentSettings.get(resource);
  if (!result) {
    // If we've reached the maximum size, remove the least recently used item
    if (documentSettings.size >= MAX_DOCUMENT_SETTINGS && documentSettingsLRU.length > 0) {
      const lruResource = documentSettingsLRU.shift();
      if (lruResource) {
        documentSettings.delete(lruResource);
      }
    }
    
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'colorize',
    }).then(settings => {
      // Ensure fileSizeLimit has a value
      if (settings.fileSizeLimit === undefined) {
        settings.fileSizeLimit = defaultSettings.fileSizeLimit;
      }
      return settings;
    });
    documentSettings.set(resource, result);
  }
  return result;
}

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
    // Also clear the LRU tracking
    documentSettingsLRU.length = 0;
  } else {
    // Use default settings if configuration capability is not available
    const settings = change.settings.colorize || defaultSettings;
    
    // Ensure fileSizeLimit has a value
    if (settings.fileSizeLimit === undefined) {
      settings.fileSizeLimit = defaultSettings.fileSizeLimit;
    }
  }

  // Revalidate all open text documents
  // documents.all().forEach(extractDocumentColors);
});

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
  
  // Also remove from LRU tracking
  const lruIndex = documentSettingsLRU.indexOf(e.document.uri);
  if (lruIndex !== -1) {
    documentSettingsLRU.splice(lruIndex, 1);
  }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((_changeEvent) => {
  // extractDocumentColors(changeEvent.document);
});

// connection.onDidOpenTextDocument
documents.onDidOpen(async (event) => {
  await extractDocumentColors(event.document);
});

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VS Code
  connection.console.log('We received a file change event');
});

// Maximum number of files to process in a single batch
const MAX_FILES_PER_BATCH = 100;

connection.onRequest(
  'colorize_extract_variables',
  async (request: { rootFolder: string; includes: string[]; excludes: string[]; fileSizeLimit?: number }) => {
    try {
      // Get settings to access fileSizeLimit
      const settings = await getDocumentSettings(request.rootFolder);
      // Use fileSizeLimit from request if provided, otherwise use from settings
      const fileSizeLimit = request.fileSizeLimit !== undefined ? request.fileSizeLimit : settings.fileSizeLimit;

      // Find all matching files
      const files = globbySync(request.includes, {
        cwd: request.rootFolder,
        ignore: request.excludes,
        absolute: true,
      });

      // Process files in chunks to prevent memory exhaustion
      const filesContent = [];
      const errors = [];

      // Process files in batches
      for (let i = 0; i < files.length; i += MAX_FILES_PER_BATCH) {
        const batch = files.slice(i, i + MAX_FILES_PER_BATCH);
        
        for (const fileName of batch) {
          try {
            // Check file size before processing
            if (!isFileSizeWithinLimit(fileName, fileSizeLimit)) {
              errors.push({
                fileName,
                error: `File size exceeds limit (${fileSizeLimit} bytes)`
              });
              continue;
            }
            
            const content = extractFileContent(fileName, fileSizeLimit);
            filesContent.push({ fileName, content });
          } catch (error) {
            // Log error and continue with next file
            connection.console.error(`Error processing file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
            errors.push({
              fileName,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      return {
        filesContent,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      connection.console.error(`Error in colorize_extract_variables: ${error instanceof Error ? error.message : String(error)}`);
      return {
        filesContent: [],
        errors: [{
          error: error instanceof Error ? error.message : String(error)
        }]
      };
    }
  },
);

// // This handler provides the initial list of the completion items.
// connection.onCompletion(
//   (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
//     // The pass parameter contains the position of the text document in
//     // which code complete got requested. For the example we ignore this
//     // info and always provide the same completion items.
//     // return [
//     //   {
//     //     label: 'TypeScript',
//     //     kind: CompletionItemKind.Text,
//     //     data: 1,
//     //   },
//     //   {
//     //     label: 'JavaScript',
//     //     kind: CompletionItemKind.Text,
//     //     data: 2,
//     //   },
//     // ];
//   },
// );

// This handler resolves additional information for the item selected in
// the completion list.
// connection.onCompletionResolve((_item: CompletionItem): CompletionItem => {
//   // if (item.data === 1) {
//   //   item.detail = 'TypeScript details';
//   //   item.documentation = 'TypeScript documentation';
//   // } else if (item.data === 2) {
//   //   item.detail = 'JavaScript details';
//   //   item.documentation = 'JavaScript documentation';
//   // }
//   // return item;
// });
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

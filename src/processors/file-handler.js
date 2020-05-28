// Copyright (c) 2020 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import {FileReader} from 'global/window';
import Console from 'global/console';
import { parse, parseInBatches } from '@loaders.gl/core';
import { JSONLoader } from '@loaders.gl/json';
import {
  processCsvData,
  processGeojson,
  processKeplerglJSON,
  processRowObject
} from './data-processor';
import {isPlainObject, generateHashId} from 'utils/utils';
import {DATASET_FORMATS} from 'constants/default-settings';

const FILE_HANDLERS = {
  csv: loadCsv,
  json: loadJSON
};

export function readFile({file, fileCache = []}) {
  return new Promise((resolve, reject) => {
    const {handler, format} = getFileHandler(file);
    if (!handler) {
      Console.warn(
        `Canont determine file handler for file ${file.name}. It must have a valid file extension`
      );
      resolve(fileCache);
    }

    handler({file, format}).then(result => {
      if (!result || !result.data) {
        // return fileCache, to keep process other files
        resolve(fileCache);
      }
      resolve([
        ...fileCache,
        {
          data: result.data,
          info: {
            label: file.name,
            format: result.format
          }
        }
      ]);
    });
  });
}

export function getFileHandler(fileBlob) {
  const type = getFileType(fileBlob.name);

  return {handler: FILE_HANDLERS[type], format: type};
}

export function getFileType(filename) {
  if (filename.endsWith('csv')) {
    return 'csv';
  } else if (filename.endsWith('json') || filename.endsWith('geojson')) {
    // Read GeoJson from browser
    return 'json';
  }

  // Wait to add other file type handler
  return 'other';
}

function readCSVFile(fileBlob) {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = ({target: {result}}) => {
      resolve(result);
    };

    fileReader.readAsText(fileBlob);
  });
}

export function loadCsv({file, format, processor = processCsvData}) {
  return readCSVFile(file).then(rawData => (rawData ? {data: processor(rawData), format} : null));
}

export function loadJSON({file, processor = processGeojson}) {
  return readJSONFile(file).then(content => {
    if (isKeplerGlMap(content)) {
      return {
        format: DATASET_FORMATS.keplergl,
        data: processKeplerglJSON(content)
      };
    } else if (isRowObject(content)) {
      return {
        format: DATASET_FORMATS.row,
        data: processRowObject(content)
      };
    } else if (isGeoJson(content)) {
      return {
        format: DATASET_FORMATS.geojson,
        data: processGeojson(content)
      };
    }
    // unsupported json format
    Console.warn(`unsupported Json format ${file.name}`);
    return null;
  });
}

async function* fileReaderAsyncIterable(file, chunkSize) {
  let offset = 0;
  while (offset < file.size) {
    const end = offset + chunkSize;
    const slice = file.slice(offset, end);
    const chunk = await new Promise((resolve, reject) => {
      const fileReader = new FileReader(file);
      fileReader.onload = (event) => {
        resolve(event.target.result);
      };
      fileReader.onerror = reject;
      fileReader.onabort = reject;
      fileReader.readAsArrayBuffer(slice);
    });
    offset = end;
    yield chunk;
  }
}

async function parseFileInBatches(file) {
  const chunkSize = 1024 * 1024; // 1MB, biggest value that keeps UI responsive
  const batchIterator = await parseInBatches(
    fileReaderAsyncIterable(file, chunkSize),
    JSONLoader,
    {
      json: { _rootObjectBatches: true }
    }
  );
  let result = {};
  let batches = [];
  for await (const batch of batchIterator) {
    // Last batch will have this special type and will provide all the root
    // properties of the parsed document.
    if (batch.batchType === "root-object-batch-complete") {
      // TODO: It would be nice if loaders.gl could handle this detail when
      // parsing in batches, otherwise we can't entirely delegate the
      // responsibility of parsing any format.
      if (batch.container.features) {
        result.features = batches;
      } else if (batch.container.datasets) {
        result.datasets = batches;
      } else {
        // HACK to get things moving, I couldn't find any realiable way to
        // identify a Row JSON—batch.container seems to equal batches[0] though.
        result = batches;
      }
      // We copy all properties but skip datasets or fatures becuase they are
      // empty arrays—we got its content in previous batches.
      for (const k in batch.container) {
        if (k !== "datasets" && k !== "features") {
          result[k] = batch.container[k];
        }
      }
    } else {
      batches = batches.concat(batch.data);
    }
  }
  return result;
}


function parseFile(file) {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader(file);
    fileReader.onload = async ({target: {result}}) => {
      try {
        const json = await parse(result, JSONLoader);
        resolve(json);
      } catch(e) {
        reject(e);
      }
    };
    fileReader.onerror = reject;
    fileReader.onabort = reject;
    fileReader.readAsText(file, 'UTF-8');
  });
}

export function readJSONFile(file) {
  // Don't read as string files with a size 250MB or bigger because it may
  // exceed the browsers maximum string length.
  return file.size >= 250 * 1024 * 1024
    ? parseFileInBatches(file)
    : parseFile(file);
}

export function isGeoJson(json) {
  // json can be feature collection
  // or simgle feature
  return isPlainObject(json) && (isFeature(json) || isFeatureCollection(json));
}

export function isFeature(json) {
  return json.type === 'Feature' && json.geometry;
}

export function isFeatureCollection(json) {
  return json.type === 'FeatureCollection' && json.features;
}

export function isRowObject(json) {
  return Array.isArray(json) && isPlainObject(json[0]);
}

export function isKeplerGlMap(json) {
  return (
    isPlainObject(json) &&
    json.datasets &&
    json.config &&
    json.info &&
    json.info.app === 'kepler.gl'
  );
}

export function determineJsonProcess({dataset, format}, defaultProcessor) {
  if (isKeplerGlMap(dataset)) {
    return processKeplerglJSON;
  }

  return defaultProcessor;
}

export function filesToDataPayload(fileCache) {
  // seperate out files which could be a single datasets. or a keplergl map json
  const collection = fileCache.reduce(
    (accu, file) => {
      const {data, info = {}} = file;
      const {format} = info;
      if (format === DATASET_FORMATS.keplergl) {
        // if file contains a single kepler map dataset & config
        accu.keplerMaps.push({
          ...data,
          options: {
            centerMap: !(data.config && data.config.mapState)
          }
        });
      } else if (DATASET_FORMATS[format]) {
        // if file contains only data
        const newDataset = {
          data,
          info: {
            id: info.id || generateHashId(4),
            ...info
          }
        };
        accu.datasets.push(newDataset);
      }
      return accu;
    },
    {datasets: [], keplerMaps: []}
  );

  // add kepler map first with config
  // add datasets later in one add data call
  return collection.keplerMaps.concat({datasets: collection.datasets});
}

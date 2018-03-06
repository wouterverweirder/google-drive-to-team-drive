//rsync example: rsync -av --exclude='*.gsheet' --exclude="*.gform" --exclude="*.gdoc" --exclude="*.gslides" --exclude="Icon?" 1718_COD/ /Volumes/GoogleDrive/Team\ Drives/Devine/20172018/modules/1718_COD

const path = require(`path`),
  fs = require(`fs-extra`),
  inquirer = require(`inquirer`),       // input prompts
  ora = require(`ora`),                 // cli spinner
  progress = require(`cli-progress`),   // progress bar
  {google} = require(`googleapis`),
  {OAuth2Client} = require('google-auth-library');

const argv = require(`yargs`)
  .command('$0 [inputFolderId] [outputFolderId]')
  .describe('inputFolderId', 'The Google Drive id of the folder whose content you want to move')
  .describe('outputFolderId', 'The Google Drive id of the destination folder')
  .describe('outputTeamDriveId', 'The id of the Team Drive of the destination folder')
  .argv;

let {
  inputFolderId,
  outputFolderId,
  outputTeamDriveId
} = argv;

const SCOPES = [`https://www.googleapis.com/auth/drive`];
const PROJECT_ROOT = path.resolve(__dirname);
const TOKEN_DIR = path.resolve(PROJECT_ROOT, `private-keys`)
const CLIENT_SECRET_PATH = path.resolve(TOKEN_DIR, `client-secret.json`);
const TOKEN_PATH = path.resolve(TOKEN_DIR, `token.json`);

const startTime = Date.now();
let currentSecond = 0;
let numRequestsCurrentSecond = 0;

const spinner = ora();

const init = async () => {

  const credentials = JSON.parse(await fs.readFile(CLIENT_SECRET_PATH));
  const oauth2Client = await authorize(credentials);
  // we are authorized, do the magic stuff here
  const drive = google.drive({
    version: `v3`,
    auth: oauth2Client
  });

  const inputQuestions = [];
  if (!inputFolderId) {
    inputQuestions.push({
      type: `input`,
      name: `inputFolderId`,
      message: `Enter the Google Drive id of the folder whose content you want to move`,
      validate: input => input.trim().length > 0
    });
  }
  if (!outputFolderId) {
    inputQuestions.push({
      type: `input`,
      name: `outputFolderId`,
      message: `Enter the Google Drive id of destination folder`,
      validate: input => input.trim().length > 0
    });
  }
  if (!outputTeamDriveId) {
    // list the team drives
    spinner.start(`Retrieving your team drives`);
    let teamDrives;
    try {
      teamDrives = await driveApiCallAsync(drive.teamdrives.list, {}, async err => {
        await pause(100);
        spinner.text = `Retrieving your team drives failed, retrying (${err})`;
        return true;
      });
    } catch (e) {
      spinner.fail(`${spinner.text} - ${e}`);
      return;
    }
    spinner.succeed(`Retrieving your team drives`);
    const choices = teamDrives.data.teamDrives.map(teamDrive => {
      return {
        name: `${teamDrive.name} (${teamDrive.id})`,
        value: teamDrive.id
      }
    }).concat([{
      name: `--- none ---`,
      value: false
    }]);

    inputQuestions.push({
      type: `list`,
      name: `outputTeamDriveId`,
      message: `Choose the Team Drive of the destination folder`,
      choices,
      validate: input => input.trim().length > 0
    });
  }

  if (inputQuestions.length > 0) {
    const answers = await inquirer.prompt(inputQuestions);
    inputFolderId = inputFolderId || answers.inputFolderId;
    outputFolderId = outputFolderId || answers.outputFolderId;
    outputTeamDriveId = outputTeamDriveId || answers.outputTeamDriveId;
  }

  // tree folder structure of input folder
  spinner.start(`Checking if input folder exists`);
  let inputTree, outputTree;
  try {
    const result  = await driveApiCallAsync(drive.files.get, {
      fileId: inputFolderId,
      fields: 'id, name'
    });
    inputTree = result.data;
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.text = `Checking if input folder exists: ${inputTree.name} (${inputTree.id})`;
  spinner.succeed();

  spinner.start(`Checking if output folder exists`);
  try {
    const result = await driveApiCallAsync(drive.files.get, {
      fileId: outputFolderId,
      fields: 'id, name',
      supportsTeamDrives: true,
      outputTeamDriveId
    });
    outputTree = result.data;
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.text = `Checking if output folder exists: ${outputTree.name} (${outputTree.id})`;
  spinner.succeed();

  spinner.start(`Retrieving folder structure of the input folder`);
  try {
    inputTree.subFolders = await getSubFoldersTree(drive, inputTree.id, {}, async err => {
      await pause(100);
      spinner.text = `Retrieving folder structure of the input folder failed, retrying (${err})`;
      return true;
    });
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.succeed();
  storeSubFoldersIntoLookupObjects(inputTree);

  // ensure we have the same folder structure in the output folder
  spinner.start(`Retrieving folder structure of the output folder`);
  try {
    outputTree.subFolders = await getSubFoldersTree(drive, outputTree.id, {supportsTeamDrives: true, teamDriveId: outputTree.teamDriveId, includeTeamDriveItems: true}, async err => {
      await pause(100);
      spinner.text = `Retrieving folder structure of the output folder failed, retrying (${err})`;
      return true;
    });
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.succeed();
  storeSubFoldersIntoLookupObjects(outputTree);

  // walk through the input tree and create folders with the same name in the output tree
  spinner.start(`Creating folder structure in output folder`);
  try {
    await createSubFoldersIfTheyDontExist(drive, inputTree, outputTree);
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.succeed();

  // create a dictionary of source folder ids to target folder ids
  const lookupObject = createFlatLookupObject(inputTree, outputTree);

  const parentIds = Object.keys(lookupObject);
  spinner.start(`Getting file structure`);
  try {
    filesToMove = await getFilesFromParents(drive, parentIds, async err => {
      await pause(100);
      spinner.text = `Getting file structure failed, retrying (${err})`;
      return true;
    });
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.succeed();

  const { moveFilesAnswer } = await inquirer.prompt([
    {
      type: `confirm`,
      name: `moveFilesAnswer`,
      message: `Are you sure you want to move ${filesToMove.length} files?`
    }
  ]);

  if (moveFilesAnswer) {
    const bar = new progress.Bar({}, progress.Presets.shades_classic);
    bar.start(filesToMove.length, 0);
    // move the files to the new folder
    for(let i = 0; i < filesToMove.length; i++) {
      const file = filesToMove[i];
      const removeParents = file.parents;
      const addParents = file.parents.filter(id => !!lookupObject[id]).map(id => lookupObject[id]);

      await driveApiCallAsync(drive.files.update, {
        fileId: file.id,
        addParents,
        removeParents,
        supportsTeamDrives: true,
        teamDriveId: outputTree.teamDriveId
      }, async err => {
        await pause(100);
        console.warn(`Move file ${file.name} failed - retrying - ${err}`);
        return true;
      });
      bar.update(i + 1);
    }
    bar.stop();

    console.log(`All Done!`);
  }
};

const getNumSecondsRunning = () => {
  return Math.floor((Date.now() - startTime) / 1000);
};

const storeSubFoldersIntoLookupObjects = folder => {
  if (!folder.subFoldersById) {
    folder.subFoldersById = {};
  }
  if (!folder.subFoldersByName) {
    folder.subFoldersByName = {};
  }
  if (!folder.subFolders) {
    folder.subFolders = [];
  }
  folder.subFolders.forEach(subFolder => {
    folder.subFoldersById[subFolder.id] = subFolder;
    folder.subFoldersByName[subFolder.name] = subFolder;
  });
};

const getSimpleTreeObject = treeObject => {
  const result = {};
  result[treeObject.name] = {};
  treeObject.subFolders.forEach(subFolder => {
    result[treeObject.name][subFolder.name] = getSimpleTreeObject(subFolder)[subFolder.name];
  });
  return result;
};

const getSubFoldersTree = async (drive, parentFolderId, extraArgs = {}, retryFn = async (err) => Promise.resolve().then(() => false)) => {
  const subFolders = await listFilesNotPaged(drive, {
    spaces: `drive`,
    fields: 'nextPageToken, files(id, name)',
    q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    ... extraArgs
  }, retryFn);
  for (let i = 0; i < subFolders.length; i++) {
    const subFolder = subFolders[i];
    subFolder.subFolders = await getSubFoldersTree(drive, subFolder.id, extraArgs, retryFn);
    // create extra lookup objects
    storeSubFoldersIntoLookupObjects(subFolder);
  }
  return subFolders;
};

/**
 * Get a flat list of all files in a given array of folder ids
 */
const getFilesFromParents = async (drive, parentIds, retryFn = async (err) => Promise.resolve().then(() => false)) => {
  const allFiles = [];
  for (let i = 0; i < parentIds.length; i++) {
    const files = await listFilesNotPaged(drive, {
      spaces: `drive`,
      fields: 'nextPageToken, files(id, name, parents)',
      q: `('${parentIds[i]}' in parents) and
      trashed = false and
      (mimeType != 'application/vnd.google-apps.folder')`
    }, retryFn);
    files.forEach(file => allFiles.push(file));
  }
  return allFiles;
};

/**
 * loop through the subFolders of a given source folder
 * check if there is a subFolder with the same name in the target folder
 * create a subFolder with that name if it doesn't exist in the target folder
 */
const createSubFoldersIfTheyDontExist = async (drive, sourceFolder, targetFolder) => {
  for (let i = 0; i < sourceFolder.subFolders.length; i++) {
    const subFolder = sourceFolder.subFolders[i];
    if (!targetFolder.subFoldersByName[subFolder.name]) {
      // create the subfolder in the targetFolder
      const {data: createdSubFolder} = await driveApiCallAsync(drive.files.create, {
        resource: {
          name: subFolder.name,
          mimeType: `application/vnd.google-apps.folder`,
          parents: [targetFolder.id]
        },
        fields: `id`,
        supportsTeamDrives: true,
        outputTeamDriveId
      }, async err => {
        await pause(100);
        console.warn(`Create folder "${subFolder.name}" failed - retrying - ${err}`);
        return true;
      });
      // add it to the tree object
      createdSubFolder.name = subFolder.name;
      storeSubFoldersIntoLookupObjects(createdSubFolder);
      targetFolder.subFolders.push(createdSubFolder);
      targetFolder.subFoldersById[createdSubFolder.id] = createdSubFolder;
      targetFolder.subFoldersByName[createdSubFolder.name] = createdSubFolder;
    }
    // process the subfolders of the subFolder
    await createSubFoldersIfTheyDontExist(drive, subFolder, targetFolder.subFoldersByName[subFolder.name]);
  };
};

const createFlatLookupObject = (sourceFolder, targetFolder, lookupObject = {}) => {
  lookupObject[sourceFolder.id] = targetFolder.id;
  sourceFolder.subFolders.forEach(sourceSubFolder => {
    const targetSubFolder = targetFolder.subFoldersByName[sourceSubFolder.name];
    if (targetSubFolder) {
      createFlatLookupObject(sourceSubFolder, targetSubFolder, lookupObject);
    }
  });
  return lookupObject;
};

const pause = async (ms, log = false) => {
  if (log) {
    console.log(`waiting ${ms}ms`);
  }
  return new Promise(resolve => {
    setTimeout(() => resolve(), ms);
  });
};

const listFilesNotPaged = async (drive, params, retryFn = async (err) => Promise.resolve().then(() => false)) => {
  let nextPageToken;
  const allFiles = [];
  do {
    const newParams = {... params, pageToken: nextPageToken};
    const response = await driveApiCallAsync(drive.files.list, newParams, retryFn);
    response.data.files.forEach(file => allFiles.push(file));
    nextPageToken = response.data.nextPageToken;
  } while (nextPageToken);
  return allFiles;
};

/**
 * Execute a call to the drive api
 * Will wait if we might run into api limits
 */
const driveApiCallAsync = async (apiCall, params, retryFn = async (err) => Promise.resolve().then(() => false)) => {

  const fn = async (apiCall, params, retryFn) => {
    // check the number of requests don the last second (limit to 10)
    const numSecondsRunning = getNumSecondsRunning();
    if (numSecondsRunning !== currentSecond) {
      currentSecond = numSecondsRunning;
      numRequestsCurrentSecond = 0;
    }
    if (numRequestsCurrentSecond >= 10) {
      await pause(100); // pause to prevent running into api limits
      return await fn(apiCall, params, retryFn);
    }
    return new Promise((resolve, reject) => {
      apiCall(params, (err, result) => {
        if (err) {
          return Promise.resolve()
            .then(() => retryFn(err))
            .then(retryResult => {
              if (retryResult) {
                return fn(apiCall, params, retryFn).then(o => resolve(o));
              }
              return reject(err);
            });
        }
        return resolve(result);
      });
    });
  }

  return await fn(apiCall, params, retryFn);
};

const authorize = async (credentials) => {
  const clientSecret = credentials.installed.client_secret;
  const clientId = credentials.installed.client_id;
  const redirectUrl = credentials.installed.redirect_uris[0];
  const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUrl);

  // check if we have stored a token before
  let token;
  try {
    token = JSON.parse(await fs.readFile(TOKEN_PATH));
  } catch (e) {
    token = await getNewToken(oauth2Client);
  }
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token));
  oauth2Client.credentials = token;
  return oauth2Client;
};

const getNewToken = async (oauth2Client) => {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: `offline`,
      scope: SCOPES
    });
    console.log(`Authorize this app by visiting this url: `, authUrl);

    inquirer.prompt([
      {
        type: `input`,
        name: `token`,
        message: `Enter the code from that page here`,
        validate: input => input.trim().length > 0
      }
    ]).then(({ token }) => {
      oauth2Client.getToken(code, function(err, token) {
        if (err) {
          return reject(err)
        }
        return resolve(token);
      });
    });
  });
};

init();

//rsync example: rsync -av --exclude='*.gsheet' --exclude="*.gform" --exclude="*.gdoc" --exclude="*.gslides" --exclude="Icon?" 1718_COD/ /Volumes/GoogleDrive/Team\ Drives/Devine/20172018/modules/1718_COD

const path = require(`path`),
  util = require(`util`),
  fs = require(`fs-extra`),
  inquirer = require(`inquirer`),       // input prompts
  ora = require(`ora`),                 // cli spinner
  progress = require(`cli-progress`),   // progress bar
  PromiseSemaphore = require(`./lib/PromiseSemaphore.js`),
  {google} = require(`googleapis`),
  {OAuth2Client} = require('google-auth-library');

const argv = require(`yargs`)
  .usage('Usage: $0 <command> [options]')
  .command('move', 'Move the files to a team drive folder')
  .command('owner', 'Change ownership (recursive) of a folder')
  .alias('i', 'inputFolderId')
  .alias('o', 'outputFolderId')
  .alias('t', 'outputTeamDriveId')
  .alias('c', 'newOwnerEmail')
  .describe('inputFolderId', 'The Google Drive id of the folder whose content you want to move')
  .describe('outputFolderId', 'The Google Drive id of the destination folder')
  .describe('outputTeamDriveId', 'The id of the Team Drive of the destination folder')
  .describe('newOwnerEmail', 'The email address of the new owner')
  .argv;

const SCOPES = [`https://www.googleapis.com/auth/drive`];
const PROJECT_ROOT = path.resolve(__dirname);
const TOKEN_DIR = path.resolve(PROJECT_ROOT, `private-keys`)
const CLIENT_SECRET_PATH = path.resolve(TOKEN_DIR, `client-secret.json`);
const TOKEN_PATH = path.resolve(TOKEN_DIR, `token.json`);

let {
  _ :[command=false] = [false],
  inputFolderId,
  outputFolderId,
  outputTeamDriveId,
  newOwnerEmail
} = argv;

const validCommands = ['move', 'owner'];

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

  // ask for the command if necessary
  if (!command || !validCommands.includes(command)) {
    const answers = await inquirer.prompt([
      {
        type: `list`,
        name: `command`,
        message: `What do you want to do?`,
        choices: [
          {
            name: 'Migrate files to team drive',
            value: 'move'
          },
          {
            name: 'Change ownership of files and folders',
            value: 'owner'
          }
        ],
        validate: input => input.trim().length > 0
      }
    ]);
    command = answers.command;
  }

  const inputQuestions = [];

  if (command === `move`) {
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
        teamDrives = await driveApiCallAsync({
          apiCall: drive.teamdrives.list,
          retryFn: async err => {
            await pause(100);
            spinner.text = `Retrieving your team drives failed, retrying (${err})`;
            return true;
          }
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
  } else if (command === `owner`) {
    if (!inputFolderId) {
      inputQuestions.push({
        type: `input`,
        name: `inputFolderId`,
        message: `Enter the Google Drive id of the folder you want to change ownership for`,
        validate: input => input.trim().length > 0
      });
    }
    if (!newOwnerEmail) {
      inputQuestions.push({
        type: `input`,
        name: `newOwnerEmail`,
        message: `Enter the Email address for the new owner`,
        validate: input => input.trim().length > 0
      });
    }
    if (inputQuestions.length > 0) {
      const answers = await inquirer.prompt(inputQuestions);
      inputFolderId = inputFolderId || answers.inputFolderId;
      newOwnerEmail = newOwnerEmail || answers.newOwnerEmail;
    }
  }

  // tree folder structure of input folder
  spinner.start(`Checking if input folder exists`);
  let inputTree, outputTree;
  try {
    const result  = await driveApiCallAsync({
      apiCall: drive.files.get,
      params: {
        fileId: inputFolderId,
        fields: 'id, name, permissions'
      }
    });
    inputTree = result.data;
    inputTree.owner = getOwnerEmailFromPermissions(inputTree.permissions);
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.text = `Checking if input folder exists: ${inputTree.name} (${inputTree.id})`;
  spinner.succeed();

  if (command === `move`) {
    spinner.start(`Checking if output folder exists`);
    try {
      const result = await driveApiCallAsync({
        apiCall: drive.files.get,
        params: {
          fileId: outputFolderId,
          fields: 'id, name, permissions',
          supportsTeamDrives: true,
          outputTeamDriveId
        }
      });
      outputTree = result.data;
      outputTree.owner = getOwnerEmailFromPermissions(outputTree.permissions);
    } catch (e) {
      spinner.fail(`${spinner.text} - ${e}`);
      return;
    }
    spinner.text = `Checking if output folder exists: ${outputTree.name} (${outputTree.id})`;
    spinner.succeed();
  }

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

  if (command === `move`) {
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
  }

  // create a dictionary of source folder ids to target folder ids
  const lookupObject = createFlatLookupObject(inputTree, outputTree);
  const parentIds = Object.keys(lookupObject);

  spinner.start(`Getting file structure`);
  try {
    filesToChange = await getFilesFromParents(drive, parentIds, async err => {
      await pause(100);
      spinner.text = `Getting file structure failed, retrying (${err})`;
      return true;
    });
  } catch (e) {
    spinner.fail(`${spinner.text} - ${e}`);
    return;
  }
  spinner.succeed();

  if (command === `move`) {
    const { confirmAnswer } = await inquirer.prompt([
      {
        type: `confirm`,
        name: `confirmAnswer`,
        message: `Are you sure you want to move ${filesToChange.length} files?`
      }
    ]);

    if (confirmAnswer) {
      const promiseSemaphore = new PromiseSemaphore(10);
      const bar = new progress.Bar({}, progress.Presets.shades_classic);
      bar.start(filesToChange.length, 0);
      let numTasksFinished = 0;
      const failedMoves = [];
      // move the files to the new folder
      for(let i = 0; i < filesToChange.length; i++) {
        const file = filesToChange[i];
        const removeParents = file.parents;
        const addParents = file.parents.filter(id => !!lookupObject[id]).map(id => lookupObject[id]);

        promiseSemaphore.add(() => {
          return driveApiCallAsync({
            apiCall: drive.files.move,
            params: {
              fileId: file.id,
              addParents,
              removeParents,
              supportsTeamDrives: true,
              teamDriveId: outputTree.teamDriveId,
              // resource: {
              //   name: file.name,
              //   parents: addParents
              // }
            },
            retryFn: async err => {
              const firstError = getFirstError(err);
              if (firstError.reason === `fileWriterTeamDriveMoveInDisabled`) {
                return false;
              }
              await pause(100);
              console.warn(`Move file ${file.name} failed - ${err}`);
              return true;
            },
            failFn: async err => {
              // store this file in a list of failed files
              failedMoves.push(file);
              return Promise.resolve();
            },
          }).then(() => {
            bar.update(++numTasksFinished);
          });
        });
      }

      await promiseSemaphore.start();
      bar.stop();

      if (failedMoves.length > 0) {
        console.log(`${failedMoves.length} files could not be moved`);
        console.log(failedMoves);
      }
    }
  } else if (command === `owner`) {
    const { confirmAnswer } = await inquirer.prompt([
      {
        type: `confirm`,
        name: `confirmAnswer`,
        message: `Are you sure you want to change ownership of ${filesToChange.length} files?`
      }
    ]);

    if (confirmAnswer) {
      const permission = {
        'type': 'user',
        'role': 'owner',
        'emailAddress': newOwnerEmail
      };

      const promiseSemaphore = new PromiseSemaphore(10);
      const bar = new progress.Bar({}, progress.Presets.shades_classic);
      bar.start(filesToChange.length, 0);
      let numTasksFinished = 0;
      const failedChanges = [];
      // change the ownership of the files
      for(let i = 0; i < filesToChange.length; i++) {
        const file = filesToChange[i];

        promiseSemaphore.add(() => {
          return driveApiCallAsync({
            apiCall: drive.permissions.create,
            params: {
              fileId: file.id,
              resource: permission,
              transferOwnership: true,
              sendNotificationEmails: false
            },
            retryFn: async err => {
              const firstError = getFirstError(err);
              if (firstError.reason === `invalidSharingRequest`) {
                return false;
              }
              await pause(100);
              console.warn(`Change ownership of ${file.name} failed - ${firstError.reason}`);
              return true;
            },
            failFn: async err => {
              // store this file in a list of failed files
              failedChanges.push(file);
              return Promise.resolve();
            },
          }).then(() => {
            bar.update(++numTasksFinished);
          });
        });
      }

      await promiseSemaphore.start();
      bar.stop();

      if (failedChanges.length > 0) {
        console.log(`${failedChanges.length} files could be changed`);
        console.log(failedChanges);
      }
    }
  }

  console.log(`Done`);
};

const getNumSecondsRunning = () => {
  return Math.floor((Date.now() - startTime) / 1000);
};

const getOwnerPermissionFromPermissions = (permissions = []) => {
  if (!Array.isArray(permissions)) {
    return false;
  }
  const [permission = false] = permissions.filter(permission => permission.role === 'owner');
  return permission;
};

const getOwnerEmailFromPermissions = (permissions = []) => {
  const { emailAddress = false } = getOwnerPermissionFromPermissions(permissions);
  return emailAddress;
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

  const promiseSemaphore = new PromiseSemaphore(10);

  const getSubFolders = (parentFolderId) => {
    return Promise.resolve()
      .then(() => {
        return listFilesNotPaged(drive, {
          spaces: `drive`,
          fields: 'nextPageToken, files(id, name, permissions)',
          q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          ... extraArgs
        }, retryFn);
      }).then(subFolders => {
        // add getSubFolders tasks to the queue
        subFolders.forEach(subFolder => {
          promiseSemaphore.add(() => {
            return getSubFolders(subFolder.id)
              .then(subSubFolders => subFolder.subFolders = subSubFolders)
              .then(() => storeSubFoldersIntoLookupObjects(subFolder));
          });
        });
        return subFolders;
      });
  };

  promiseSemaphore.add(() => {
    return getSubFolders(parentFolderId)
      .then(result => rootSubFolders = result);
  });

  await promiseSemaphore.start();

  return rootSubFolders;
};

/**
 * Get a flat list of all files in a given array of folder ids
 */
const getFilesFromParents = async (drive, parentIds, retryFn = async (err) => Promise.resolve().then(() => false)) => {
  const allFiles = [];

  const promiseSemaphore = new PromiseSemaphore(10);

  for (let i = 0; i < parentIds.length; i++) {
    promiseSemaphore.add(() => {
      return listFilesNotPaged(drive, {
        spaces: `drive`,
        fields: 'nextPageToken, files(id, name, parents, permissions)',
        q: `('${parentIds[i]}' in parents) and
        trashed = false and
        (mimeType != 'application/vnd.google-apps.folder')`
      }, retryFn).then(files => {
        files.forEach(file => {
          file.owner = getOwnerEmailFromPermissions(file.permissions);
          allFiles.push(file)
        });
      });
    });
  }

  await promiseSemaphore.start();

  return allFiles;
};

/**
 * loop through the subFolders of a given source folder
 * check if there is a subFolder with the same name in the target folder
 * create a subFolder with that name if it doesn't exist in the target folder
 */
const createSubFoldersIfTheyDontExist = async (drive, sourceFolder, targetFolder) => {

  const promiseSemaphore = new PromiseSemaphore(10);

  const createSubFolderIfItDoesntExist = (sourceSubFolder, targetFolder) => {
    let seq = Promise.resolve();
    if (!targetFolder.subFoldersByName[sourceSubFolder.name]) {
      seq = seq.then(() => {
        return driveApiCallAsync({
          apiCall: drive.files.create,
          params: {
            resource: {
              name: sourceSubFolder.name,
              mimeType: `application/vnd.google-apps.folder`,
              parents: [targetFolder.id]
            },
            fields: `id`,
            supportsTeamDrives: true,
            outputTeamDriveId
          },
          retryFn: async err => {
            await pause(100);
            console.warn(`Create folder "${sourceSubFolder.name}" failed - retrying - ${err}`);
            return true;
          }
        });
      }).then(({ data: createdSubFolder }) => {
        // add it to the tree object
        createdSubFolder.name = sourceSubFolder.name;
        storeSubFoldersIntoLookupObjects(createdSubFolder);
        targetFolder.subFolders.push(createdSubFolder);
        targetFolder.subFoldersById[createdSubFolder.id] = createdSubFolder;
        targetFolder.subFoldersByName[createdSubFolder.name] = createdSubFolder;
      });
    }
    seq = seq.then(() => {
      const targetSubFolder = targetFolder.subFoldersByName[sourceSubFolder.name];
      sourceSubFolder.subFolders.forEach(sourceSubSubFolder => {
        // add createSubFolderIfItDoesntExist tasks to the queue
        promiseSemaphore.add(() => {
          return createSubFolderIfItDoesntExist(sourceSubSubFolder, targetSubFolder);
        });
      });
    });
    return seq;
  };

  sourceFolder.subFolders.forEach(sourceSubFolder => {
    promiseSemaphore.add(() => {
      return createSubFolderIfItDoesntExist(sourceSubFolder, targetFolder);
    });
  });

  await promiseSemaphore.start();
};

const createFlatLookupObject = (sourceFolder, targetFolder, lookupObject = {}) => {
  if (!targetFolder) { // in move command we dont have target folder
    targetFolder = sourceFolder;
  }
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
    const response = await driveApiCallAsync({
      apiCall: drive.files.list,
      params: newParams,
      retryFn
    });
    response.data.files.forEach(file => {
      file.owner = getOwnerEmailFromPermissions(file.permissions);
      allFiles.push(file)
    });
    nextPageToken = response.data.nextPageToken;
  } while (nextPageToken);
  return allFiles;
};

/**
 * Execute a call to the drive api
 * Will wait if we might run into api limits
 */
const driveApiCallAsync = async ( options ) => {
  const {
    apiCall,
    params = {},
    retryFn = async (err) => Promise.resolve().then(() => false),
    failFn = async (err) => Promise.reject(err)
  } = options;

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
                return fn(apiCall, params, retryFn);
              }
              return failFn(err);
            })
            .then(o => resolve(o))
            .catch(err => reject(err));
        }
        return resolve(result);
      });
    });
  }

  return await fn(apiCall, params, retryFn);
};

const getFirstError = (error) => {
  const { errors:[first=false] = [false] } = error;
  return first;
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
        name: `code`,
        message: `Enter the code from that page here`,
        validate: input => input.trim().length > 0
      }
    ]).then(({ code }) => {
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

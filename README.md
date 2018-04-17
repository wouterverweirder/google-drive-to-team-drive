# Migrate Google Drive content to Team Drive

This nodejs cli app moves content from a Google Drive folder to a Team Drive folder. The process happens fully online, you don't need to have the files / folders offline.

This project was created because migrating content through the web interface or with the Desktop app had issues with Google Suite (gdoc, gslides, gsheet, gform) files & folders. Using the standard Google tools, it isn't possible to move Google Suite files with the file stream app. Uing the web interface, it isn't possible to move folders as a whole. This means you're stuck doing a lot of manual work when migrating content.

## Installation

- Download this repo and use npm / yarn to install it's dependencies
- Create a project on https://console.developers.google.com/apis for this project
- Create an oAuth client secret for your project at https://console.developers.google.com/apis/credentials - Application Type is "other"
- Download the client secret you just created, and place it in a folder called "private-keys" in the root of this project. Rename the file to "client-secret.json"

## Usage

Run node index.js to go through an interactive shell wizard.

```
$ node index.js
```
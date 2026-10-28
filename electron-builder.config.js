'use strict';

// On GitHub Actions GITHUB_REPOSITORY is set, so we build the small web installer: one .exe that
// downloads the launcher files from this repository's release during installation.
// Everywhere else (a local build) we build the regular offline installer.
const repo = process.env.GITHUB_REPOSITORY;
const web = !!repo;

const installer = {
  oneClick: false, // shows the "choose install folder" page
  perMachine: false, // no admin rights needed
  allowToChangeInstallationDirectory: true,
  runAfterFinish: true,
  createDesktopShortcut: 'always',
  createStartMenuShortcut: true,
  shortcutName: 'CP77 Launcher v2',
  deleteAppDataOnUninstall: false,
  language: '1049', // Russian installer
  artifactName: 'cp-77-v2-setup-${version}.${ext}',
};

module.exports = {
  appId: 'com.cp77.launcher.v2',
  productName: 'cp-77-v2', // also the default install folder name
  files: [
    'main.js',
    'preload.js',
    'lib/**',
    'src/**',
    '!**/node_modules/7zip-bin/{linux,mac}/**',
    '!**/node_modules/*/{test,tests,docs,example,examples}/**',
    '!**/*.{md,map,ts}',
  ],
  asarUnpack: ['node_modules/7zip-bin/**', 'node_modules/node-unrar-js/**'],
  win: { target: web ? 'nsis-web' : 'nsis', signAndEditExecutable: false },
  forceCodeSigning: false,
  nsis: installer,
  nsisWeb: installer,
  ...(web && { publish: { provider: 'github', owner: repo.split('/')[0], repo: repo.split('/')[1], releaseType: 'release' } }),
};

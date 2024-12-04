// import { app, BrowserWindow } from 'electron';
//
// function createWindow() {
//     const w = new BrowserWindow({
//         width: 800,
//         height: 600,
//         webPreferences: {
//             nodeIntegration: true, // For simplicity in this minimal example
//             contextIsolation: false,
//         },
//     });
//
//     w.loadURL(`data:text/html,
//         <html>
//           <head>
//             <title>AI Assistant Status</title>
//           </head>
//           <body>
//             <h1>Running</h1>
//           </body>
//         </html>
//   `);
// }
//
// app.whenReady().then(() => {
//     createWindow();
//
//     app.on('activate', function () {
//         if (BrowserWindow.getAllWindows().length === 0) createWindow();
//     });
// });
//
// app.on('window-all-closed', function () {
//     if (process.platform !== 'darwin') app.quit();
// });
export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    console.log("XtoMD Clipper installed.");
  });
});

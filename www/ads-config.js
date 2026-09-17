/* Test ads only by default. Load before rewarded-ads.js. See ADS_SETUP.md. */
(function (w) {
  'use strict';
  w.REWARDED_ADS_CONFIG = Object.assign({
    enabled: true,
    testMode: true,
    productionEnabled: false,
    androidRewardedAdUnitId: '',
    // Release requires an explicit, reviewed audience declaration.
    audienceDeclared: false,
    tagForChildDirectedTreatment: false,
    tagForUnderAgeOfConsent: false
  }, w.REWARDED_ADS_CONFIG || {});
})(window);

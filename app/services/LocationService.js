import { GetStoreData, SetStoreData } from '../helpers/General';
import BackgroundGeolocation from '@mauron85/react-native-background-geolocation';
import { Alert, Platform, Linking } from 'react-native';
import { PERMISSIONS, check, RESULTS, request } from 'react-native-permissions';
import PushNotificationIOS from '@react-native-community/push-notification-ios';
import SafePathsAPI from './API';
import { EventRegister } from 'react-native-event-listeners';

import PushNotification from 'react-native-push-notification';
import UUIDGenerator from 'react-native-uuid-generator';

import _ from 'lodash';

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import point from 'turf-point';
import polygon from 'turf-polygon';

let instanceCount = 0;
let lastPointCount = 0;
// let locationInterval = 60000 * 5; // Time (in milliseconds) between location information polls.  E.g. 60000*5 = 5 minutes
// // DEBUG: Reduce Time intervall for faster debugging
// let locationInterval = 5000;

export function setHomeLocation(location) {
  SetStoreData('HOME_LOCATION', location);
}

export function setWorkLocation(location) {
  SetStoreData('WORK_LOCATION', location);
}

export function getHomeLocation() {
  return GetStoreData('HOME_LOCATION');
}

export function getWorkLocation() {
  return GetStoreData('WORK_LOCATION');
}

export class LocationData {
  constructor() {
    this.locationInterval = 60000 * 5; // Time (in milliseconds) between location information polls.  E.g. 60000*5 = 5 minutes
    // DEBUG: Reduce Time intervall for faster debugging
    // this.locationInterval = 5000;
    // around 55 meters
    this.degreesFromBannedLocation = 0.00025;
    this.homeLocation = null;
    this.workLocation = null;
    this.homePolygon = null;
    this.workPolygon = null;

    this.getBlacklistedLocations();
    this.homeLocationListener = EventRegister.addEventListener(
      'set-HOME-location',
      coordinates => {
        console.log('SETTING HOME LOCATION: ', coordinates);
        this.createLocationPolygon(coordinates, 'Home');
      },
    );
    this.workLocationListener = EventRegister.addEventListener(
      'set-WORK-location',
      coordinates => {
        console.log('SETTING WORK LOCATION: ', coordinates);
        this.createLocationPolygon(coordinates, 'Work');
      },
    );
  }

  createLocationPolygon(location, label) {
    if (location && location.length === 2) {
      const pt = point(location);
      const lng = location[0];
      const lat = location[1];
      const poly = polygon([
        [
          [lng - 0.00025, lat + this.degreesFromBannedLocation],
          [lng - 0.00025, lat - this.degreesFromBannedLocation],
          [lng + 0.00025, lat - this.degreesFromBannedLocation],
          [lng + 0.00025, lat + this.degreesFromBannedLocation],
          [lng - 0.00025, lat + this.degreesFromBannedLocation],
        ],
      ]);

      if (label === 'Home') {
        this.homeLocation = pt;
        this.homePolygon = poly;
      } else if (label === 'Work') {
        this.workLocation = pt;
        this.workPolygon = poly;
      }
    } else {
      if (label === 'Home') {
        this.homeLocation = null;
        this.homePolygon = null;
      } else if (label === 'Work') {
        this.workLocation = null;
        this.workPolygon = null;
      }
    }
  }

  getBlacklistedLocations() {
    getHomeLocation().then(location => {
      const parsedLocation = JSON.parse(location);
      console.log('BLACKLIST HOME:', parsedLocation);
      if (parsedLocation && parsedLocation.length === 2) {
        this.createLocationPolygon(parsedLocation, 'Home');
      }
    });
    getWorkLocation().then(location => {
      const parsedLocation = JSON.parse(location);
      console.log('BLACKLIST WORK:', location);
      if (parsedLocation && parsedLocation.length === 2) {
        this.createLocationPolygon(parsedLocation, 'Work');
      }
    });
  }

  getLocationData() {
    return GetStoreData('LOCATION_DATA').then(locationArrayString => {
      let locationArray = [];
      if (locationArrayString !== null) {
        locationArray = JSON.parse(locationArrayString);
      }

      return locationArray;
    });
  }

  async getPointStats() {
    const locationData = await this.getLocationData();

    let lastPoint = null;
    let firstPoint = null;
    let pointCount = 0;

    if (locationData.length) {
      lastPoint = locationData.slice(-1)[0];
      firstPoint = locationData[0];
      pointCount = locationData.length;
    }

    return {
      lastPoint,
      firstPoint,
      pointCount,
    };
  }

  saveLocation(location) {
    // Persist this location data in our local storage of time/lat/lon values
    this.getLocationData().then(locationArray => {
      // Always work in UTC, not the local time in the locationData
      let nowUTC = new Date().toISOString();
      let unixtimeUTC = Date.parse(nowUTC);
      let unixtimeUTC_28daysAgo = unixtimeUTC - 60 * 60 * 24 * 1000 * 28;

      // Curate the list of points, only keep the last 28 days
      let curated = [];
      for (let i = 0; i < locationArray.length; i++) {
        if (locationArray[i]['time'] > unixtimeUTC_28daysAgo) {
          curated.push(locationArray[i]);
        }
      }

      // Backfill the stationary points, if available
      if (curated.length >= 1) {
        let lastLocationArray = curated[curated.length - 1];
        let lastTS = lastLocationArray['time'];
        for (
          ;
          lastTS < unixtimeUTC - this.locationInterval;
          lastTS += this.locationInterval
        ) {
          curated.push(JSON.parse(JSON.stringify(lastLocationArray)));
        }
      }

      // Save the location using the current lat-lon and the
      // calculated UTC time (maybe a few milliseconds off from
      // when the GPS data was collected, but that's unimportant
      // for what we are doing.)
      console.log('[GPS] Saving point:', locationArray.length);
      let lat_lon_time = {
        latitude: location['latitude'],
        longitude: location['longitude'],
        time: unixtimeUTC,
      };
      curated.push(lat_lon_time);
      const currentLocation = {
        latitude: location['latitude'],
        longitude: location['longitude'],
      };
      SetStoreData('LOCATION_DATA', curated);
      if (
        (this.homeLocation && this.homePolygon) ||
        (this.workLocation && this.workPolygon)
      ) {
        const currentLocationPoint = point([
          currentLocation.longitude,
          currentLocation.latitude,
        ]);
        if (this.homeLocation && this.homePolygon) {
          console.log(
            'IS CLOSE TO HOME ',
            booleanPointInPolygon(currentLocationPoint, this.homePolygon),
          );
        }
        if (this.workLocation && this.workPolygon) {
          console.log(
            'IS CLOSE TO WORK ',
            booleanPointInPolygon(currentLocationPoint, this.workPolygon),
          );
        }
        if (
          (this.homeLocation &&
            this.homePolygon &&
            booleanPointInPolygon(currentLocationPoint, this.homePolygon)) ||
          (this.workLocation &&
            this.workPolygon &&
            booleanPointInPolygon(currentLocationPoint, this.workPolygon))
        ) {
          console.log('[WARNING] TOO CLOSE BANNED AREA');
        } else {
          SafePathsAPI.saveMyLocation(currentLocation);
        }
      } else {
        SafePathsAPI.saveMyLocation(currentLocation);
      }
    });
  }
}

export default class LocationServices {
  static start(callback) {
    const locationData = new LocationData();
    // FOR DEBUGGING ONLY
    // global.window.locationData = locationData;

    instanceCount += 1;
    if (instanceCount > 1) {
      BackgroundGeolocation.start();
      return;
    }

    try {
      GetStoreData('uuid').then(myUUID => {
        if (!myUUID) {
          UUIDGenerator.getRandomUUID(uuid => {
            console.log('SETTING UUID ', uuid);
            SetStoreData('uuid', uuid);
          });
          return;
        }
      });
    } catch (e) {
      console.log(e, 'did not get UUID');
    }

    PushNotification.configure({
      // (required) Called when a remote or local notification is opened or received
      onNotification: function(notification) {
        console.log('NOTIFICATION:', notification);
        // required on iOS only (see fetchCompletionHandler docs: https://github.com/react-native-community/react-native-push-notification-ios)
        notification.finish(PushNotificationIOS.FetchResult.NoData);
      },
      requestPermissions: true,
    });

    // PushNotificationIOS.requestPermissions();
    BackgroundGeolocation.configure({
      desiredAccuracy: BackgroundGeolocation.HIGH_ACCURACY,
      stationaryRadius: 5,
      distanceFilter: 5,
      notificationTitle: 'Spaced Enabled',
      notificationText:
        'Spaced is securely storing your GPS coordinates once every five minutes on this device.',
      debug: false, // when true, it beeps every time a loc is read
      startOnBoot: true,
      stopOnTerminate: false,
      locationProvider: BackgroundGeolocation.DISTANCE_FILTER_PROVIDER,

      interval: locationData.locationInterval,
      fastestInterval: locationData.locationInterval,
      activitiesInterval: locationData.locationInterval,

      activityType: 'AutomotiveNavigation',
      pauseLocationUpdates: false,
      saveBatteryOnBackground: true,
      stopOnStillActivity: false,
    });

    BackgroundGeolocation.on('location', location => {
      // handle your locations here
      /* SAMPLE OF LOCATION DATA OBJECT
                {
                  "accuracy": 20, "altitude": 5, "id": 114, "isFromMockProvider": false,
                  "latitude": 37.4219983, "locationProvider": 1, "longitude": -122.084,
                  "mockLocationsEnabled": false, "provider": "fused", "speed": 0,
                  "time": 1583696413000
                }
            */
      // to perform long running operation on iOS
      // you need to create background task
      BackgroundGeolocation.startTask(taskKey => {
        // execute long running task
        // eg. ajax post location
        // IMPORTANT: task has to be ended by endTask
        locationData.saveLocation(location);
        BackgroundGeolocation.endTask(taskKey);
      });
    });

    if (Platform.OS === 'android') {
      // This feature only is present on Android.
      BackgroundGeolocation.headlessTask(async event => {
        // Application was shutdown, but the headless mechanism allows us
        // to capture events in the background.  (On Android, at least)
        if (event.name === 'location' || event.name === 'stationary') {
          locationData.saveLocation(event.params);
        }
      });
    }

    BackgroundGeolocation.on('stationary', stationaryLocation => {
      // handle stationary locations here
      // Actions.sendLocation(stationaryLocation);
      BackgroundGeolocation.startTask(taskKey => {
        // execute long running task
        // eg. ajax post location
        // IMPORTANT: task has to be ended by endTask

        // For capturing stationaryLocation. Note that it hasn't been
        // tested as I couldn't produce stationaryLocation callback in emulator
        // but since the plugin documentation mentions it, no reason to keep
        // it empty I believe.
        locationData.saveLocation(stationaryLocation);
        BackgroundGeolocation.endTask(taskKey);
      });
      console.log('[INFO] stationaryLocation:', stationaryLocation);
    });

    BackgroundGeolocation.on('error', error => {
      console.log('[ERROR] BackgroundGeolocation error:', error);
    });

    BackgroundGeolocation.on('start', () => {
      console.log('[INFO] BackgroundGeolocation service has been started');
      if (callback) callback();
    });

    BackgroundGeolocation.on('stop', () => {
      console.log('[INFO] BackgroundGeolocation service has been stopped');
    });

    BackgroundGeolocation.on('authorization', status => {
      console.log(
        '[INFO] BackgroundGeolocation authorization status: ' + status,
      );

      if (status !== BackgroundGeolocation.AUTHORIZED) {
        // we need to set delay or otherwise alert may not be shown
        setTimeout(
          () =>
            Alert.alert(
              'Spaced requires access to location information',
              'Would you like to open app settings?',
              [
                {
                  text: 'Yes',
                  onPress: () => BackgroundGeolocation.showAppSettings(),
                },
                {
                  text: 'No',
                  onPress: () => console.log('No Pressed'),
                  style: 'cancel',
                },
              ],
            ),
          1000,
        );
      } else {
        BackgroundGeolocation.start(); //triggers start on start event

        // TODO: We reach this point on Android when location services are toggled off/on.
        //       When this fires, check if they are off and show a Notification in the tray
      }
    });

    BackgroundGeolocation.on('background', () => {
      console.log('[INFO] App is in background');
    });

    BackgroundGeolocation.on('foreground', () => {
      console.log('[INFO] App is in foreground');
    });

    BackgroundGeolocation.on('abort_requested', () => {
      console.log('[INFO] Server responded with 285 Updates Not Required');
      // Here we can decide whether we want stop the updates or not.
      // If you've configured the server to return 285, then it means the server does not require further update.
      // So the normal thing to do here would be to `BackgroundGeolocation.stop()`.
      // But you might be counting on it to receive location updates in the UI, so you could just reconfigure and set `url` to null.
    });

    BackgroundGeolocation.on('http_authorization', () => {
      console.log('[INFO] App needs to authorize the http requests');
    });

    BackgroundGeolocation.on('stop', () => {
      PushNotification.localNotification({
        title: 'Location Tracking Was Disabled',
        message: 'Spaced requires location services.',
      });
      console.log('[INFO] stop');
    });

    BackgroundGeolocation.on('stationary', () => {
      console.log('[INFO] stationary');
    });

    BackgroundGeolocation.checkStatus(status => {
      console.log(
        '[INFO] BackgroundGeolocation service is running',
        status.isRunning,
      );
      console.log(
        '[INFO] BackgroundGeolocation services enabled',
        status.locationServicesEnabled,
      );
      console.log(
        '[INFO] BackgroundGeolocation auth status: ' + status.authorization,
      );

      BackgroundGeolocation.start(); //triggers start on start event

      if (!status.locationServicesEnabled) {
        // we need to set delay or otherwise alert may not be shown
        setTimeout(
          () =>
            Alert.alert(
              'Spaced requires location services to be enabled',
              'Would you like to open location settings?',
              [
                {
                  text: 'Yes',
                  onPress: () => {
                    if (Platform.OS === 'android') {
                      // showLocationSettings() only works for android
                      BackgroundGeolocation.showLocationSettings();
                    } else {
                      Linking.openURL('App-Prefs:Privacy'); // Deeplinking method for iOS
                    }
                  },
                },
                {
                  text: 'No',
                  onPress: () => console.log('No Pressed'),
                  style: 'cancel',
                },
              ],
            ),
          1000,
        );
      } else if (!status.authorization) {
        // we need to set delay or otherwise alert may not be shown
        setTimeout(
          () =>
            Alert.alert(
              'Spaced requires access to location information',
              'Would you like to open app settings?',
              [
                {
                  text: 'Yes',
                  onPress: () => BackgroundGeolocation.showAppSettings(),
                },
                {
                  text: 'No',
                  onPress: () => console.log('No Pressed'),
                  style: 'cancel',
                },
              ],
            ),
          1000,
        );
      }
      // else if (!status.isRunning) {
      // } // commented as it was not being used
    });

    // you can also just start without checking for status
    // BackgroundGeolocation.start();
  }

  static stop() {
    // unregister all event listeners
    PushNotification.localNotification({
      title: 'Location Tracking Was Disabled',
      message: 'Spaced requires location services.',
    });
    BackgroundGeolocation.removeAllListeners();
    BackgroundGeolocation.stop();
    instanceCount -= 1;
    SetStoreData('PARTICIPATE', 'false').then(() => {
      // nav.navigate('LocationTrackingScreen', {});
    });
  }
}

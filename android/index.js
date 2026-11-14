/**
 * @format
 */

import React, { useEffect, useState } from 'react';
import { AppRegistry } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { name as appName } from './app.json';

// The language chosen in Settings → Language has to be known before any screen module is loaded
// (the texts are picked when the modules load). So the app itself is only required after the saved
// choice has been read; if reading fails, the phone's language is used.
function Root() {
  const [AppComponent, setAppComponent] = useState(null);
  useEffect(() => {
    let alive = true;
    const start = () => {
      if (alive) {
        setAppComponent(() => require('./App').default);
      }
    };
    AsyncStorage.getItem('rom1rv:language')
      .then(v => { globalThis.__ROM1RV_LANG = v; })
      .catch(() => undefined)
      .then(start);
    return () => { alive = false; };
  }, []);
  return AppComponent ? React.createElement(AppComponent) : null;
}

AppRegistry.registerComponent(appName, () => Root);

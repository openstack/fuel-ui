/*
 * Copyright 2014 Mirantis, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License. You may obtain
 * a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
**/
import $ from 'jquery';
import _ from 'underscore';
import Backbone from 'backbone';
import i18n from 'i18n';
import React from 'react';
import ReactDOM from 'react-dom';
import dispatcher from 'dispatcher';
import {DiscardSettingsChangesDialog} from 'views/dialogs';

export {default as backboneMixin} from 'react_backbone_mixin';

export function dispatcherMixin(events, callback) {
  return {
    componentDidMount() {
      dispatcher.on(events, _.isString(callback) ? this[callback] : callback, this);
    },
    componentWillUnmount() {
      dispatcher.off(null, null, this);
    }
  };
}

export var unsavedChangesMixin = {
  onBeforeunloadEvent() {
    if (this.hasChanges()) {
      return _.result(this, 'getStayMessage') || i18n('dialog.dismiss_settings.default_message');
    }
  },
  componentWillMount() {
    this.eventName = _.uniqueId('unsavedchanges');
    $(window).on('beforeunload.' + this.eventName, this.onBeforeunloadEvent);
    app.onLeave = this.onLeave;
    app.baseComponent = this.constructor;
  },
  componentWillUnmount() {
    $(window).off('beforeunload.' + this.eventName);
    app.onLeave = null;
    app.baseComponent = null;
  },
  onLeave() {
    if (_.result(this, 'hasChanges')) {
      return DiscardSettingsChangesDialog
        .show({
          isDiscardingPossible: _.result(this, 'isDiscardingPossible'),
          isSavingPossible: _.result(this, 'isSavingPossible'),
          applyChanges: this.applyChanges,
          revertChanges: this.revertChanges
        });
    }
  }
};

export function pollingMixin(updateInterval, delayedStart) {
  updateInterval = updateInterval * 1000;
  return {
    scheduleDataFetch() {
      var shouldDataBeFetched = !_.isFunction(this.shouldDataBeFetched) ||
        this.shouldDataBeFetched();
      if (this.isMounted() && !this.activeTimeout && shouldDataBeFetched) {
        this.activeTimeout = _.delay(this.startPolling, updateInterval);
      }
    },
    startPolling(force) {
      var shouldDataBeFetched = force || !_.isFunction(this.shouldDataBeFetched) ||
        this.shouldDataBeFetched();
      if (shouldDataBeFetched) {
        this.stopPolling();
        return this.fetchData().then(this.scheduleDataFetch, this.scheduleDataFetch);
      }
    },
    stopPolling() {
      if (this.activeTimeout) clearTimeout(this.activeTimeout);
      delete this.activeTimeout;
    },
    componentDidMount() {
      if (delayedStart) {
        this.scheduleDataFetch();
      } else {
        this.startPolling();
      }
    },
    componentWillUnmount() {
      this.stopPolling();
    }
  };
}

export var outerClickMixin = {
  propTypes: {
    toggle: React.PropTypes.func
  },
  getInitialState() {
    return {
      clickEventName: 'click.' + _.uniqueId('outer-click')
    };
  },
  handleBodyClick(e) {
    if (!$(e.target).closest(ReactDOM.findDOMNode(this)).length) {
      _.defer(_.partial(this.props.toggle, false));
    }
  },
  componentDidMount() {
    if (this.props.toggle) {
      $('html').on(this.state.clickEventName, this.handleBodyClick);
      Backbone.history.on('route', _.partial(this.props.toggle, false), this);
    }
  },
  componentWillUnmount() {
    if (this.props.toggle) {
      $('html').off(this.state.clickEventName);
      Backbone.history.off('route', null, this);
    }
  }
};

export function renamingMixin(refname) {
  return {
    getInitialState() {
      return {
        isRenaming: false,
        renamingMixinEventName: 'click.' + _.uniqueId('rename')
      };
    },
    componentWillUnmount() {
      $('html').off(this.state.renamingMixinEventName);
    },
    startRenaming(e) {
      e.preventDefault();
      $('html').on(this.state.renamingMixinEventName, (e) => {
        if (e && !$(e.target).closest(ReactDOM.findDOMNode(this.refs[refname])).length) {
          this.endRenaming();
        } else {
          e.preventDefault();
        }
      });
      this.setState({isRenaming: true});
    },
    endRenaming() {
      $('html').off(this.state.renamingMixinEventName);
      this.setState({
        isRenaming: false,
        actionInProgress: false
      });
    }
  };
}

export var loadPropsMixin = {
  statics: {
    loadProps(params, cb) {
      dispatcher.trigger('pageLoadStarted');
      if (!_.isEmpty(app.routerComponent)) {
        // If router is available one can determine how deep current component in the route
        // and reuse higher-level prefetched data for own fetches
        var depth = app.routerComponent.state.routes.reduce((depth, route, index) => {
          if (route.component === this) depth = index;
          return depth;
        });
        // Unneeded data can be dropped
        app.fetchDataPromises = _.take(app.fetchDataPromises, depth - 1);
      }

      if (this.waitForParentData && !_.isEmpty(app.fetchDataPromises)) {
        // Component's data fetch method depends on parent's data,
        // so it has to be fetched first
        var parent = _.last(app.fetchDataPromises).then((dataFetched) => {
          return (
            _.invoke(this, 'fetchData', _.extend({}, params, dataFetched)) ||
            Promise.resolve(dataFetched)
          )
            .then(
              (props) => {
                dispatcher.trigger('pageLoadFinished');
                cb(null, props);
                return props;
              },
              (error) => {
                dispatcher.trigger('pageLoadFinished');
                cb(null, {});
                return error;
              }
            );
        });
        app.fetchDataPromises.push(parent);
      } else {
        // Component is not dependent on its parent' data so it can start own fetching
        // asynchronously
        app.fetchDataPromises.push(new Promise((resolve, reject) =>
          (_.invoke(this, 'fetchData', params) || Promise.resolve({})).then(
            (props) => {
              dispatcher.trigger('pageLoadFinished');
              cb(null, props);
              return resolve(props);
            },
            (error) => {
              dispatcher.trigger('pageLoadFinished');
              cb(null, null);
              return reject(error);
            }
          )
        ));
      }
    }
  }
};

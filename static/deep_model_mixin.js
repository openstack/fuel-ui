/*
 * Copyright 2016 Mirantis, Inc.
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

/**
 *
 * Backbone.DeepModel v0.10.4
 *
 * Copyright (c) 2013 Charles Davison, Pow Media Ltd
 *
 * https://github.com/powmedia/backbone-deep-model
 * Licensed under the MIT License
 */

import _ from 'underscore';
import Backbone from 'backbone';

// Takes a nested object and returns a shallow object keyed with the path names
// e.g. { "level1.level2": "value" }
var objToPaths = (obj) => {
  var result = {};
  _.each(obj, (val, key) => {
    if (_.isPlainObject(val) && !_.isEmpty(val)) {
      //Recursion for embedded objects
      var obj2 = objToPaths(val);
      _.each(obj2, (val2, key2) => {
        result[key + '.' + key2] = val2;
      });
    } else {
      result[key] = val;
    }
  });
  return result;
};

var deepExtendCouple = (destination, source, maxDepth = 20) => {
  var plainObjects = (object) => _.filter(_.keys(object), (key) => _.isPlainObject(object[key]));
  var arrays = (object) => _.filter(_.keys(object), (key) => _.isArray(object[key]));

  if (maxDepth <= 0) return _.extend(destination, source);

  var sharedObjectKeys = _.intersection(plainObjects(destination), plainObjects(source));
  var recurse = (key) =>
    source[key] = deepExtendCouple(destination[key], source[key], maxDepth - 1);
  _.each(sharedObjectKeys, recurse);

  var sharedArrayKeys = _.intersection(arrays(destination), arrays(source));
  var combine = (key) => source[key] = _.union(destination[key], source[key]);
  _.each(sharedArrayKeys, combine);
  return _.extend(destination, source);
};

var deepExtend = function() {
  var objects = _.initial(arguments);
  var maxDepth = _.last(arguments);

  if (!_.isNumber(maxDepth)) {
    objects.push(maxDepth);
    maxDepth = 20;
  }
  if (objects.length <= 1) return _.head(objects);
  if (maxDepth <= 0) _.extend.apply(this, objects);

  var result = objects.shift();
  while (objects.length > 0) {
    result = deepExtendCouple(result, _.cloneDeep(objects.shift()), maxDepth);
  }
  return result;
};

//based on https://github.com/powmedia/backbone-deep-model
var DeepModel = Backbone.Model.extend({
  constructor(attributes, options) {
    var attrs = attributes || {};
    this.cid = _.uniqueId('c');
    this.attributes = {};
    if (options && options.collection) this.collection = options.collection;
    if (options && options.parse) attrs = this.parse(attrs, options) || {};
    var defaults = _.result(this, 'defaults');
    attrs = deepExtend({}, defaults, attrs);
    this.set(attrs, options);
    this.changed = {};
    this.initialize(...arguments);
  },

  toJSON() {
    return _.cloneDeep(this.attributes);
  },

  get(attr) {
    return _.get(this.attributes, attr);
  },

  set(key, val, options = {}) {
    if (key === null) return this;

    // Handle both `"key", value` and `{key: value}` -style arguments.
    var attrs;
    if (typeof key === 'object') {
      attrs = key;
      options = val || {};
    } else {
      (attrs = {})[key] = val;
    }

    // Run validation.
    if (!this._validate(attrs, options)) return false;

    // Extract attributes and options.
    var {unset, silent} = options;
    var changes = [];
    var changing = this._changing;
    this._changing = true;

    if (!changing) {
      this._previousAttributes = _.cloneDeep(this.attributes); // Replaced _.clone with _.cloneDeep
      this.changed = {};
    }

    var current = this.attributes;
    var changed = this.changed;
    var prev = this._previousAttributes;

    // Check for changes of `id`.
    if (attrs[this.idAttribute]) this.id = attrs[this.idAttribute];

    attrs = objToPaths(attrs);

    // For each `set` attribute, update or delete the current value.
    _.each(attrs, (val, attr) => {
      if (!_.isEqual(_.get(current, attr), val)) changes.push(attr);
      if (!_.isEqual(_.get(prev, attr), val)) {
        _.setWith(changed, attr, val, Object);
      } else {
        _.unset(changed, attr);
      }
      if (unset) {
        _.unset(current, attr);
      } else {
        _.setWith(current, attr, val, Object);
      }
    });

    // Trigger all relevant attribute changes.
    if (!silent) {
      if (changes.length) this._pending = true;
      _.each(changes, (change) => {
        this.trigger('change:' + change, this, _.get(current, change), options);
        var fields = change.split('.');
        //Trigger change events for parent keys with wildcard (*) notation
        _.eachRight(fields, (field, key) => {
          if (key > 0) {
            var parentKey = _.take(fields, key).join('.');
            var wildcardKey = parentKey + '.*';
            this.trigger('change:' + wildcardKey, this, _.get(current, parentKey), options);
          }
        });
      });
    }

    if (changing) return this;
    if (!silent) {
      while (this._pending) {
        this._pending = false;
        this.trigger('change', this, options);
      }
    }
    this._pending = false;
    this._changing = false;
    return this;
  },

  // Clear all attributes on the model, firing `"change"` unless you choose
  // to silence it.
  clear(options) {
    var attrs = {};
    var shallowAttributes = objToPaths(this.attributes);
    _.each(shallowAttributes, (attr, key) => {
      attrs[key] = undefined;
    });
    return this.set(attrs, _.extend({}, options, {unset: true}));
  },

  // Determine if the model has changed since the last `"change"` event.
  // If you specify an attribute name, determine if that attribute has changed.
  hasChanged(attr) {
    if (_.isNull(attr)) return !_.isEmpty(this.changed);
    return !_.isUndefined(_.get(this.changed, attr));
  },

  // Return an object containing all the attributes that have changed, or
  // false if there are no changed attributes. Useful for determining what
  // parts of a view need to be updated and/or what attributes need to be
  // persisted to the server. Unset attributes will be set to undefined.
  // You can also pass an attributes object to diff against the model,
  // determining if there *would be* a change.
  changedAttributes(diff) {
    if (!diff) return this.hasChanged() ? objToPaths(this.changed) : false;
    var old = this._changing ? this._previousAttributes : this.attributes;
    diff = objToPaths(diff);
    old = objToPaths(old);

    var changed = false;
    _.each(diff, (val, attr) => {
      if (!_.isEqual(old[attr], val)) {
        (changed || (changed = {}))[attr] = val;
      }
    });
    return changed;
  },

  // Get the previous value of an attribute, recorded at the time the last
  // `"change"` event was fired.
  previous(attr) {
    if (attr === null || !this._previousAttributes) return null;
    return _.get(this._previousAttributes, attr);
  },

  // Get all of the attributes of the model at the time of the previous
  // `"change"` event.
  previousAttributes() {
    return _.cloneDeep(this._previousAttributes);
  }
});

export default DeepModel;

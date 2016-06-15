/*
 * Copyright 2015 Mirantis, Inc.
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
import React from 'react';
import i18n from 'i18n';
import utils from 'utils';
import models from 'models';
import dispatcher from 'dispatcher';
import Expression from 'expression';
import OffloadingModes from 'views/cluster_page_tabs/nodes_tab_screens/offloading_modes_control';
import {Input, Tooltip, ProgressButton} from 'views/controls';
import {backboneMixin, unsavedChangesMixin} from 'component_mixins';
import {DragSource, DropTarget} from 'react-dnd';
import ReactDOM from 'react-dom';
import SettingSection from 'views/cluster_page_tabs/setting_section';

setTimeout(()=> {app.version.set('feature_groups', [])}, 100);

var ns = 'cluster_page.nodes_tab.configure_interfaces.';
// changing this var cause SettingSection to refresh
var settingSectionKey = _.now();

var EditNodeInterfacesScreen = React.createClass({
  mixins: [
    backboneMixin('interfaces', 'change reset update'),
    backboneMixin('cluster'),
    backboneMixin('nodes', 'change reset update'),
    backboneMixin({
      modelOrCollection(props) {
        var attributes = _.map(props.interfaces.models, (ifc) => ifc.get('attributes'));
        return attributes[0];
      },
      renderOn: 'update change'
    }),
    unsavedChangesMixin
  ],
  statics: {
    fetchData(options) {
      var cluster = options.cluster;
      var nodes = utils.getNodeListFromTabOptions(options);

      if (!nodes || !nodes.areInterfacesConfigurable()) {
        return $.Deferred.reject();
      }

      var networkConfiguration = cluster.get('networkConfiguration');
      var networksMetadata = new models.ReleaseNetworkProperties();
      var bondDefaultAttributes = new models.BondDefaultAttributes();
      bondDefaultAttributes.id = nodes.at(0).id;

      return $.when(...nodes.map((node) => {
        node.interfaces = new models.Interfaces();
        return node.interfaces.fetch({
          url: _.result(node, 'url') + '/interfaces',
          reset: true
        });
      }).concat([
        networkConfiguration.fetch({cache: true}),
        networksMetadata.fetch({
          url: '/api/releases/' + cluster.get('release_id') + '/networks'
        }),
        bondDefaultAttributes.fetch({cache: true})
      ]))
        .then(() => {
          var interfaces = new models.Interfaces();
          interfaces.set(_.cloneDeep(nodes.at(0).interfaces.toJSON()), {parse: true});
          return {
            interfaces: interfaces,
            nodes: nodes,
            bondingConfig: networksMetadata.get('bonding'),
            bondDefaultAttributes: bondDefaultAttributes,
            configModels: {
              version: app.version,
              cluster: cluster,
              settings: cluster.get('settings')
            }
          };
        });
    }
  },
  getInitialState() {
    var interfacesByIndex = {};
    var indexByInterface = {};
    var firstNodeInterfaces = this.props.interfaces.filter((ifc) => !ifc.isBond());
    this.props.nodes.each((node, nodeIndex) => {
      var justInterfaces = node.interfaces.filter((ifc) => !ifc.isBond());
      _.each(justInterfaces, (ifc, index) => {
        indexByInterface[ifc.id] = index;
        interfacesByIndex[index] = _.union(
          interfacesByIndex[index],
          [nodeIndex ? ifc : firstNodeInterfaces[index]]
        );
      });
    });
    var viewMode = _.first(this.props.viewModes);

    return {
      actionInProgress: false,
      interfacesErrors: {},
      interfacesByIndex,
      indexByInterface,
      viewMode
    };
  },
  getDefaultProps() {
    return {
      viewModes: ['standard', 'compact']
    };
  },
  componentWillMount() {
    this.setState({
      initialInterfaces: _.cloneDeep(this.interfacesToJSON(this.props.interfaces)),
      limitations: this.getEditLimitations()
    });
  },
  componentDidMount() {
    this.validate();
  },
  compareInterfaceAttributes(interfaces, attributePath) {
    // Checks if all the sub parameters are equal for all interfaces property
    var attributes = _.map(interfaces, (ifc) => {
      return ifc.get('attributes').get(attributePath);
    });
    var shown = _.first(attributes);
    var equal = _.every(attributes, (attribute) => _.isEqual(attribute, shown));
    return {equal, shown};
  },
  getInterfacesLimitations(interfaces) {
    var limitations = {};
    var firstIfc = interfaces[0];
    var firstIfcAttributes = firstIfc.get('attributes');
    _.each(_.omit(firstIfcAttributes, 'metadata'), (section, sectionName) => {
      limitations[sectionName] = limitations[sectionName] || {};
      _.each(_.omit(section, 'metadata'), (setting, settingName) => {
        limitations[sectionName][settingName] =
          this.compareInterfaceAttributes(interfaces,
            utils.makePath(sectionName, settingName, 'value'));
      });
    });
    return limitations;
  },
  getEditLimitations() {
    // Gets limitations for interfaces parameters editing.
    // Parameter should not be editable if it is differently available
    // across the nodes interfaces.
    // There are 3 types of interfaces to be treaten differently:
    // 1) interface (supposed to be similar on all nodes by index, unremovable)
    // 2) saved bonds (might be configured differently across the nodes,
    //    removable, affect interfaces order)
    // 3) unsaved bonds (exist on the first node only)

    var {interfacesByIndex, indexByInterface} = this.state;

    // Calculate limitations for case 1
    var result = _.reduce(
      interfacesByIndex,
      (result, interfaces) => {
        result[interfaces[0].id] = this.getInterfacesLimitations(interfaces);
        return result;
      }, {}
    );

    // Limitations for cases 2 and 3
    _.each(
      this.props.interfaces.filter((ifc) => ifc.isBond()),
      (ifc) => {
        var interfaces = _.flatten(
          _.map(ifc.getSlaveInterfaces(),
            (slave) => interfacesByIndex[indexByInterface[slave.id]]
          )
        );
        result[ifc.get('name')] = this.getInterfacesLimitations(interfaces);
      }
    );
    return result;
  },
  isLocked() {
    return !!this.props.cluster.task({group: 'deployment', active: true}) ||
      !_.every(this.props.nodes.invoke('areInterfacesConfigurable'));
  },
  interfacesPickFromJSON(json) {
    // Pick certain interface fields that have influence on hasChanges.
    return _.pick(json, [
      'assigned_networks', 'mode', 'type', 'slaves',
      'attributes', 'offloading_modes'
    ]);
  },
  interfacesToJSON(interfaces, remainingNodesMode) {
    // Sometimes 'state' is sent from the API and sometimes not
    // It's better to just unify all inputs to the one without state.
    var picker = remainingNodesMode ? this.interfacesPickFromJSON : (json) => _.omit(json, 'state');
    return interfaces.map((ifc) => picker(ifc.toJSON()));
  },
  hasChangesInRemainingNodes() {
    var initialInterfacesData = _.map(this.state.initialInterfaces, this.interfacesPickFromJSON);
    var limitationsKeys = this.props.nodes.at(0).interfaces.map(
      (ifc) => ifc.get(ifc.isBond ? 'name' : 'id')
    );

    return _.some(this.props.nodes.slice(1), (node) => {
      var interfacesData = this.interfacesToJSON(node.interfaces, true);
      return _.some(initialInterfacesData, (ifcData, index) => {
        var limitations = this.state.limitations[limitationsKeys[index]];
        var omittedProperties = _.filter(
          _.keys(limitations),
          (key) => !_.get(limitations[key], 'equal', true)
        );
        return _.some(ifcData, (data, attribute) => {
          // Restricted parameters should not participate in changes detection
          switch (attribute) {
            case 'offloading_modes': {
              // Do not compare offloading modes if they differ
              if (!_.get(limitations, 'offloading_modes.equal', false)) return false;
              // otherwise remove set states before it
              return !_.isEqual(..._.invoke(
                  [data, interfacesData[index][attribute]],
                  (value) => utils.deepOmit(value, ['state']))
              );
            }
            case 'attributes': {
              // Omit restricted parameters from the comparison
              return !_.isEqual(..._.invoke(
                [data, interfacesData[index][attribute]],
                _.omit, omittedProperties)
              );
            }
            case 'slaves': {
              // bond 'slaves' attribute contains information about slave name only
              // but interface names can be different between nodes
              // and can not be used for the comparison
              return data.length !== (interfacesData[index].slaves || {}).length;
            }
          }
          return !_.isEqual(data, interfacesData[index][attribute]);
        });
      });
    });
  },
  hasChanges() {
    return !this.isLocked() &&
      (!_.isEqual(this.state.initialInterfaces, this.interfacesToJSON(this.props.interfaces)) ||
      this.props.nodes.length > 1 && this.hasChangesInRemainingNodes());
  },
  loadDefaults() {
    this.setState({actionInProgress: 'load_defaults'});
    this.props.interfaces.fetch({
      url: _.result(this.props.nodes.at(0), 'url') + '/interfaces/default_assignment', reset: true
    })
    .fail(
      (response) => {
        var errorNS = ns + 'configuration_error.';
        utils.showErrorDialog({
          title: i18n(errorNS + 'title'),
          message: i18n(errorNS + 'load_defaults_warning'),
          response: response
        });
      }
    )
    .then(() => {
      settingSectionKey = _.now();
      this.setState({actionInProgress: false});
    });
  },
  revertChanges() {
    settingSectionKey = _.now();
    this.props.interfaces.reset(_.cloneDeep(this.state.initialInterfaces), {parse: true});
  },
  updateWithLimitations(sourceInterface, targetInterface) {
    // Interface parameters should be updated with respect to limitations:
    // restricted parameters should not be changed
    var limitations = this.state.limitations[targetInterface.id];
    var targetAttributes = targetInterface.get('attributes');
    var sourceAttributes = sourceInterface.get('attributes');

    _.each(sourceAttributes.attributes, (section, sectionName) => {
      _.each(section, (setting, settingName) => {
        var path = [sectionName, settingName].join('.');
        if (_.get(limitations, utils.makePath(sectionName, settingName, 'equal'), false)) {
          targetAttributes.set(path, sourceAttributes.get(path));
        }
      });
    });
  },
  applyChanges() {
    if (!this.isSavingPossible()) return Promise.reject();
    this.setState({actionInProgress: 'apply_changes'});

    var nodes = this.props.nodes;
    var interfaces = this.props.interfaces;
    var bond = interfaces.filter((ifc) => ifc.isBond());
    var bondsByName = bond.reduce((result, bond) => {
      result[bond.get('name')] = bond;
      return result;
    }, {});

    // bonding map contains indexes of slave interfaces
    // it is needed to build the same configuration for all the nodes
    // as interface names might be different, so we use indexes
    var bondingMap = _.map(bond,
      (bond) => _.map(bond.get('slaves'), (slave) => interfaces.indexOf(interfaces.find(slave)))
    );

    return Promise.all(nodes.map((node) => {
      var oldNodeBonds, nodeBonds;
      // removing previously configured bond
      oldNodeBonds = node.interfaces.filter((ifc) => ifc.isBond());
      node.interfaces.remove(oldNodeBonds);
      // creating node-specific bond without slaves
      nodeBonds = _.map(bond, (bond) => {
        return new models.Interface(_.omit(bond.toJSON(), 'slaves'), {parse: true});
      });
      node.interfaces.add(nodeBonds);
      // determining slaves using bonding map
      _.each(nodeBonds, (bond, bondIndex) => {
        var slaveIndexes = bondingMap[bondIndex];
        var slaveInterfaces = _.map(slaveIndexes, (index) => node.interfaces.at(index));
        bond.set({slaves: _.invoke(slaveInterfaces, 'pick', 'name')});
      });

      // Assigning networks according to user choice and interface properties
      node.interfaces.each((ifc, index) => {
        var updatedIfc = ifc.isBond() ? bondsByName[ifc.get('name')] : interfaces.at(index);
        ifc.set({
          assigned_networks: new models.InterfaceNetworks(
            updatedIfc.get('assigned_networks').toJSON()
          )
        });
        this.updateWithLimitations(updatedIfc, ifc);
      });

      return Backbone.sync('update', node.interfaces, {url: _.result(node, 'url') + '/interfaces'});
    }))
      .then(
        () => {
          this.setState({
            initialInterfaces: _.cloneDeep(this.interfacesToJSON(this.props.interfaces)),
            actionInProgress: false
          });
          dispatcher.trigger('networkConfigurationUpdated');
        },
        (response) => {
          var errorNS = ns + 'configuration_error.';
          this.setState({actionInProgress: false});
          utils.showErrorDialog({
            title: i18n(errorNS + 'title'),
            message: i18n(errorNS + 'saving_warning'),
            response: response
          });
        }
      );
  },
  configurationTemplateExists() {
    return !_.isEmpty(this.props.cluster.get('networkConfiguration')
      .get('networking_parameters').get('configuration_template'));
  },
  getAvailableBondingTypes(ifc) {
    if (ifc.isBond()) return [ifc.get('attributes').get('type__.value')];

    return _.compact(
      _.flatten(
        _.map(
          this.props.bondingConfig.availability,
          (modesAvailability) => _.map(
            modesAvailability,
            (condition, mode) => (new Expression(
              condition, this.props.configModels, {strict: false}
            )).evaluate({interface: ifc}) && mode
          )
    )));
  },
  findOffloadingModesIntersection(set1, set2) {
    return _.map(
      _.intersection(
        _.map(set1, 'name'),
        _.map(set2, 'name')
      ),
      (name) => {
        return {
          name: name,
          state: null,
          sub: this.findOffloadingModesIntersection(
            _.find(set1, {name: name}).sub,
            _.find(set2, {name: name}).sub
          )
        };
      });
  },
  getIntersectedOffloadingModes(interfaces) {
    var offloadingModes = interfaces.map((ifc) => ifc.get('offloading_modes') || []);
    if (!offloadingModes.length) return [];

    return offloadingModes.reduce((result, modes) => {
      return this.findOffloadingModesIntersection(result, modes);
    });
  },
  getOffloadingModesIntersection(interfaces) {
    var omitState = (modes) => {
      modes = _.map(modes, (mode) => {
        mode = _.omit(mode, 'state');
        mode.sub = omitState(mode.sub);
        return mode;
      });
      return modes;
    };
    var firstInterfaceModes = _.first(interfaces).get('meta').offloading_modes;
    var allTheSame = _.every(interfaces,
      (ifc) => {
        var modes = ifc.get('meta').offloading_modes;
        return _.isEqual(omitState(firstInterfaceModes), omitState(modes));
      }
    );
    var attributes = _.first(interfaces).get('attributes');
    return {
      offloading_modes: allTheSame ? firstInterfaceModes : [],
      modes: attributes.get('offloading.modes.value')
    };
  },
  bondInterfaces(bondType) {
    this.setState({actionInProgress: true});
    var interfaces = this.props.interfaces.filter((ifc) => ifc.get('checked') && !ifc.isBond());
    var bond = this.props.interfaces.find((ifc) => ifc.get('checked') && ifc.isBond());
    var limitations = this.state.limitations;
    var bondName;

    var bondAttributes = {};
    if (!bond) {
      // if no bond selected - create new one
      var bondMode = _.flatten(
        _.map(this.props.bondingConfig.properties[bondType].mode, 'values')
      )[0];
      bondName = this.props.interfaces.generateBondName('bond');
      var offloading = this.getOffloadingModesIntersection(interfaces);

      bondAttributes = new models.NICAttributes(this.props.bondDefaultAttributes.toJSON());
      bondAttributes.set('type__.value', bondType);
      bondAttributes.set('mode.value', {value: bondMode});
      bondAttributes.set('offloading.modes.value', offloading.modes);
      bondAttributes.set('offloading.modes.value', offloading.modes);
      bondAttributes.set('dpdk.enabled.value', _.every(interfaces,
          (ifc) => ifc.get('attributes').get('dpdk.enabled.value') === true
      ));
      var bondProperties = {
        type: 'bond',
        name: bondName,
        mode: bondMode,
        assigned_networks: new models.InterfaceNetworks(),
        slaves: _.invoke(interfaces, 'pick', 'name'),
        meta: {
          dpdk: {
            available: _.every(interfaces,
                (ifc) => ifc.get('meta').dpdk.available
            )
          },
          offloading_modes: offloading.offloading_modes
        },
        state: 'down'
      };
      bond = new models.Interface(bondProperties);
      bond.set('attributes', bondAttributes);
      limitations[bondName] = {};
    } else {
      // adding interfaces to existing bond
      bondAttributes = bond.get('attributes');
      bondName = bond.get('name');

      if (bondAttributes.get('dpdk.enabled.value')) {
        bondAttributes.set('dpdk.enabled.value', _.every(interfaces,
          (ifc) => ifc.get('attributes').get('dpdk.enabled.value')
        ));
      }
      bond.set({
        slaves: bond.get('slaves').concat(_.invoke(interfaces, 'pick', 'name')),
        offloading_modes: this.getIntersectedOffloadingModes(interfaces.concat(bond)),
        attributes: bondAttributes
      });
      // remove the bond to add it later and trigger re-rendering
      this.props.interfaces.remove(bond, {silent: true});
    }
    limitations[bondName] = _.reduce(interfaces, (result, ifc) => {
      bond.get('assigned_networks').add(ifc.get('assigned_networks').models);
      ifc.get('assigned_networks').reset();
      ifc.set({checked: false});
      return this.mergeLimitations(result, limitations[ifc.id]);
    }, limitations[bondName]);

    this.props.interfaces.add(bond);
    this.setState({
      actionInProgress: false,
      limitations
    });
  },
  mergeLimitations(limitation1, limitation2) {
    return _.merge(limitation1, limitation2, (value1, value2, interfaceProperty) => {
      switch (interfaceProperty) {
        case 'mtu':
        case 'offloading_modes':
          // Offloading modes are presumed to be calculated intersection
          return {equal: true, shown: true};
        case 'dpdk':
          if (_.isUndefined(value1) || _.isUndefined(value2)) break;

          // Both interfaces should support DPDK in order bond to support it either
          var equal = true;
          var shown = value1.shown && value2.shown;
          return {equal: equal, shown: shown};
        case 'sriov':
          return {equal: true, shown: false};
      }
    });
  },
  unbondInterfaces() {
    this.setState({actionInProgress: true});
    _.each(this.props.interfaces.filter({checked: true}), (bond) => {
      this.removeInterfaceFromBond(bond.get('name'));
    });
    this.setState({actionInProgress: false});
  },
  removeInterfaceFromBond(bondName, slaveInterfaceName) {
    var networks = this.props.cluster.get('networkConfiguration').get('networks');
    var bond = this.props.interfaces.find({name: bondName});
    var slaves = bond.get('slaves');
    var bondHasUnmovableNetwork = bond.get('assigned_networks').some((interfaceNetwork) => {
      return interfaceNetwork.getFullNetwork(networks).get('meta').unmovable;
    });
    var slaveInterfaceNames = _.map(slaves, 'name');
    var targetInterface = bond;

    // if PXE interface is being removed - place networks there
    if (bondHasUnmovableNetwork) {
      var pxeInterface = this.props.interfaces.find((ifc) => {
        return ifc.get('pxe') && _.includes(slaveInterfaceNames, ifc.get('name'));
      });
      if (!slaveInterfaceName || pxeInterface && pxeInterface.get('name') === slaveInterfaceName) {
        targetInterface = pxeInterface;
      }
    }

    // if slaveInterfaceName is set - remove it from slaves, otherwise remove all
    if (slaveInterfaceName) {
      var slavesUpdated = _.reject(slaves, {name: slaveInterfaceName});
      var names = _.map(slavesUpdated, 'name');
      var bondSlaveInterfaces = this.props.interfaces.filter(
        (ifc) => _.includes(names, ifc.get('name'))
      );

      bond.set({
        slaves: slavesUpdated,
        offloading_modes: this.getIntersectedOffloadingModes(bondSlaveInterfaces)
      });
    } else {
      bond.set('slaves', []);
    }

    // destroy bond if all slave interfaces have been removed
    if (!slaveInterfaceName && targetInterface === bond) {
      targetInterface = this.props.interfaces.find({name: slaveInterfaceNames[0]});
    }

    // move networks if needed
    if (targetInterface !== bond) {
      var interfaceNetworks = bond.get('assigned_networks').remove(
        bond.get('assigned_networks').models
      );
      targetInterface.get('assigned_networks').add(interfaceNetworks);
    }

    // if no slaves left - remove the bond
    if (!bond.get('slaves').length) {
      this.props.interfaces.remove(bond);
    }
  },
  validate() {
    var {interfaces, cluster} = this.props;
    if (!interfaces) return;

    var interfacesErrors = {};
    var networkConfiguration = cluster.get('networkConfiguration');
    var networkingParameters = networkConfiguration.get('networking_parameters');
    var networks = networkConfiguration.get('networks');
    var slaveInterfaceNames = _.map(_.flatten(_.filter(interfaces.map('slaves'))), 'name');

    interfaces.each((ifc) => {
      if (!_.includes(slaveInterfaceNames, ifc.get('name'))) {
        var errors = ifc.validate({
          networkingParameters: networkingParameters,
          networks: networks
        }, {cluster});
        if (!_.isEmpty(errors)) interfacesErrors[ifc.get('name')] = errors;

        var attributesErrors = ifc.get('attributes').validationError;
        if (!_.isEmpty(attributesErrors)) interfacesErrors[ifc.get('name')] = attributesErrors;
      }
    });

    if (!_.isEqual(this.state.interfacesErrors, interfacesErrors)) {
      this.setState({interfacesErrors});
    }
  },
  validateSpeedsForBonding(interfaces) {
    var slaveInterfaces = _.flatten(_.invoke(interfaces, 'getSlaveInterfaces'), true);
    var speeds = _.invoke(slaveInterfaces, 'get', 'current_speed');
    // warn if not all speeds are the same or there are interfaces with unknown speed
    return _.uniq(speeds).length > 1 || !_.compact(speeds).length;
  },
  isSavingPossible() {
    return !_.chain(this.state.interfacesErrors).values().some().value() &&
      !this.state.actionInProgress && this.hasChanges();
  },
  getInterfaceProperty(property) {
    var {interfaces, nodes} = this.props;
    var bondsCount = interfaces.filter((ifc) => ifc.isBond()).length;
    var getPropertyValues = (ifcIndex) => {
      return _.uniq(nodes.map((node) => {
        var nodeBondsCount = node.interfaces.filter((ifc) => ifc.isBond()).length;
        var nodeInterface = node.interfaces.at(ifcIndex + nodeBondsCount);
        if (property === 'current_speed') return utils.showBandwidth(nodeInterface.get(property));
        return nodeInterface.get(property);
      }));
    };
    return interfaces.map((ifc, index) => {
      if (ifc.isBond()) {
        return _.map(ifc.get('slaves'),
          (slave) => getPropertyValues(interfaces.indexOf(interfaces.find(slave)) - bondsCount)
        );
      }
      return [getPropertyValues(index - bondsCount)];
    });
  },
  getAvailableBondingTypesForInterfaces(interfaces) {
    return _.intersection(... _.map(interfaces, this.getAvailableBondingTypes));
  },
  changeViewMode() {
    var viewMode = _.first(_.without(this.props.viewModes, this.state.viewMode));
    this.setState({viewMode});
  },
  render() {
    var nodesByNetworksMap = {};
    this.props.nodes.each((node) => {
      var networkNames = _.flatten(
        node.interfaces.map((ifc) => ifc.get('assigned_networks').map('name'))
      ).sort();
      nodesByNetworksMap[networkNames] = _.union((nodesByNetworksMap[networkNames] || []),
        [node.id]);
    });
    if (_.size(nodesByNetworksMap) > 1) {
      return (
        <ErrorScreen
          {... _.pick(this.props, 'nodes', 'cluster')}
          nodesByNetworksMap={nodesByNetworksMap}
        />
      );
    }

    var {nodes, interfaces} = this.props;
    var {interfacesByIndex, indexByInterface, viewMode} = this.state;
    var nodeNames = nodes.map('name');
    var locked = this.isLocked();
    var configurationTemplateExists = this.configurationTemplateExists();

    var checkedInterfaces = interfaces.filter((ifc) => ifc.get('checked') && !ifc.isBond());
    var checkedBonds = interfaces.filter((ifc) => ifc.get('checked') && ifc.isBond());

    var creatingNewBond = checkedInterfaces.length >= 2 && !checkedBonds.length;
    var addingInterfacesToExistingBond = !!checkedInterfaces.length && checkedBonds.length === 1;

    // Available bonding types for interfaces slice across the nodes
    var availableBondingTypes = {};
    var nodesInterfaces = interfaces.map((ifc) => {
      var interfacesSlice = ifc.isBond() ?
        _.map(
          ifc.getSlaveInterfaces(),
          (slave) => interfacesByIndex[indexByInterface[slave.id]]
        )
      :
        interfacesByIndex[indexByInterface[ifc.id]];

      var bondingTypesSlice = ifc.isBond() ?
        _.flatten(_.union([ifc], interfacesSlice.map(_.tail)))
      :
        interfacesSlice;
      availableBondingTypes[ifc.get('name')] =
          this.getAvailableBondingTypesForInterfaces(bondingTypesSlice);

      return _.flatten(interfacesSlice);
    });

    var bondType = _.intersection(... _.compact(_.map(availableBondingTypes,
      (types, ifcName) => {
        var ifc = interfaces.find({name: ifcName});
        return ifc && ifc.get('checked') ? types : null;
      }
    )))[0];
    var bondingPossible = (creatingNewBond || addingInterfacesToExistingBond) && !!bondType;

    var unbondingPossible = !checkedInterfaces.length && !!checkedBonds.length;

    var hasChanges = this.hasChanges();
    var slaveInterfaceNames = _.pluck(_.flatten(_.filter(interfaces.pluck('slaves'))), 'name');
    var loadDefaultsEnabled = !this.state.actionInProgress;
    var revertChangesEnabled = !this.state.actionInProgress && hasChanges;

    var invalidSpeedsForBonding = bondingPossible &&
      this.validateSpeedsForBonding(checkedBonds.concat(checkedInterfaces)) ||
      interfaces.some((ifc) => ifc.isBond() && this.validateSpeedsForBonding([ifc]));

    var interfaceSpeeds = this.getInterfaceProperty('current_speed');
    var interfaceNames = this.getInterfaceProperty('name');
    console.log('interfaces', interfaces);

    return (
      <div className='ifc-management-panel row'>
        <div className='title'>
          {i18n(ns + (locked ? 'read_only_' : '') + 'title',
            {count: nodes.length, name: nodeNames.join(', ')})}
        </div>
        {configurationTemplateExists &&
          <div className='col-xs-12'>
            <div className='alert alert-warning'>
              {i18n(ns + 'configuration_template_warning')}
            </div>
          </div>
        }
        <div className='view-mode-switcher col-xs-4'>
        </div>
        {_.some(availableBondingTypes, (bondingTypes) => bondingTypes.length) &&
          !configurationTemplateExists &&
          !locked && [
            <div className='bonding-buttons-box text-right col-xs-8' key='bond-actions'>
              <div className='btn-group'>
                <button
                  className='btn btn-default btn-bond'
                  onClick={() => this.bondInterfaces(bondType)}
                  disabled={!bondingPossible}
                >
                  {i18n(ns + 'bond_button')}
                </button>
                <button
                  className='btn btn-default btn-unbond'
                  onClick={this.unbondInterfaces}
                  disabled={!unbondingPossible}
                >
                  {i18n(ns + 'unbond_button')}
                </button>
              </div>
            </div>,
            <div className='col-xs-12' key='bonds-warnings'>
              {!bondingPossible && checkedInterfaces.concat(checkedBonds).length > 1 &&
                <div className='alert alert-warning'>
                  {i18n(ns + (
                    checkedBonds.length > 1 ?
                    'several_bonds_warning' :
                    'interfaces_cannot_be_bonded'
                  ))}
                </div>}

              {invalidSpeedsForBonding &&
                <div className='alert alert-warning'>
                  {i18n(ns + 'bond_speed_warning')}
                </div>}
            </div>
          ]}
        <div className='ifc-list col-xs-12'>
          {interfaces.map((ifc, index) => {
            var ifcName = ifc.get('name');
            var limitations = this.state.limitations[ifc.isBond() ? ifcName : ifc.id];

            if (!_.includes(slaveInterfaceNames, ifcName)) {
              return (
                <NodeInterfaceDropTarget
                  {...this.props}
                  key={'interface-' + ifcName}
                  interface={ifc}
                  limitations={limitations}
                  nodesInterfaces={nodesInterfaces[index]}
                  hasChanges={
                    !_.isEqual(
                       _.find(this.state.initialInterfaces, {name: ifcName}),
                      _.omit(ifc.toJSON(), 'state')
                    )
                  }
                  locked={locked}
                  configurationTemplateExists={configurationTemplateExists}
                  errors={this.state.interfacesErrors[ifcName]}
                  validate={this.validate}
                  removeInterfaceFromBond={this.removeInterfaceFromBond}
                  bondingProperties={this.props.bondingConfig.properties}
                  availableBondingTypes={availableBondingTypes[ifcName]}
                  getAvailableBondingTypes={this.getAvailableBondingTypes}
                  interfaceSpeeds={interfaceSpeeds[index]}
                  interfaceNames={interfaceNames[index]}
                  viewMode={viewMode}
                />
              );
            }
          })}
        </div>
        <div className='col-xs-12 page-buttons content-elements'>
          <div className='well clearfix'>
            <div className='btn-group'>
              <a
                className='btn btn-default'
                href={'/cluster/' + this.props.cluster.id + '/nodes'}
                disabled={this.state.actionInProgress}
              >
                {i18n('cluster_page.nodes_tab.back_to_nodes_button')}
              </a>
            </div>
            {!locked &&
              <div className='btn-group pull-right'>
                <ProgressButton
                  className='btn btn-default btn-defaults'
                  onClick={this.loadDefaults}
                  disabled={!loadDefaultsEnabled}
                  progress={this.state.actionInProgress === 'load_defaults'}
                >
                  {i18n('common.load_defaults_button')}
                </ProgressButton>
                <button
                  className='btn btn-default btn-revert-changes'
                  onClick={this.revertChanges}
                  disabled={!revertChangesEnabled}
                >
                  {i18n('common.cancel_changes_button')}
                </button>
                <ProgressButton
                  className='btn btn-success btn-apply'
                  onClick={this.applyChanges}
                  disabled={!this.isSavingPossible()}
                  progress={this.state.actionInProgress === 'apply_changes'}
                >
                  {i18n('common.apply_button')}
                </ProgressButton>
              </div>
            }
          </div>
        </div>
      </div>
    );
  }
});

var ErrorScreen = React.createClass({
  render() {
    var {nodes, cluster, nodesByNetworksMap} = this.props;
    return (
      <div className='ifc-management-panel row'>
        <div className='title'>
          {i18n(
            ns + 'read_only_title',
            {count: nodes.length, name: nodes.map('name').join(', ')}
          )}
        </div>
        {_.size(nodesByNetworksMap) > 1 &&
          <div className='col-xs-12'>
            <div className='alert alert-danger different-networks-alert'>
              {i18n(ns + 'nodes_have_different_networks')}
              {_.map(nodesByNetworksMap, (nodeIds, networkNames) => {
                return (
                  <a
                    key={networkNames}
                    className='no-leave-check'
                    href={
                      '/cluster/' + cluster.id + '/nodes/interfaces/' +
                      utils.serializeTabOptions({nodes: nodeIds})
                    }
                  >
                    {i18n(ns + 'node_networks', {
                      count: nodeIds.length,
                      networks: _.map(networkNames.split(','), (name) => i18n('network.' + name))
                        .join(', ')
                    })}
                  </a>
                );
              })}
            </div>
          </div>
        }
        <div className='col-xs-12 page-buttons content-elements'>
          <div className='well clearfix'>
            <div className='btn-group'>
              <a
                className='btn btn-default'
                href={'/cluster/' + cluster.id + '/nodes'}
              >
                {i18n('cluster_page.nodes_tab.back_to_nodes_button')}
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }
});

var NodeInterface = React.createClass({
  statics: {
    target: {
      drop(props, monitor) {
        var targetInterface = props.interface;
        var sourceInterface = props.interfaces.find({name: monitor.getItem().interfaceName});
        var network = sourceInterface.get('assigned_networks')
          .find({name: monitor.getItem().networkName});
        sourceInterface.get('assigned_networks').remove(network);
        targetInterface.get('assigned_networks').add(network);
        // trigger 'change' event to update screen buttons state
        targetInterface.trigger('change', targetInterface);
      },
      canDrop(props, monitor) {
        return monitor.getItem().interfaceName !== props.interface.get('name');
      }
    },
    collect(connect, monitor) {
      return {
        connectDropTarget: connect.dropTarget(),
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop()
      };
    }
  },
  mixins: [
    backboneMixin('interface'),
    backboneMixin({
      modelOrCollection(props) {
        return props.interface.get('attributes');
      }
    }),
    backboneMixin({
      modelOrCollection(props) {
        return props.interface.get('assigned_networks');
      }
    })
  ],
  componentDidUpdate() {
    this.props.validate();
  },
  isLacpRateAvailable() {
    return _.includes(this.getBondPropertyValues('lacp_rate', 'for_modes'), this.getBondMode());
  },
  isHashPolicyNeeded() {
    return _.includes(this.getBondPropertyValues('xmit_hash_policy', 'for_modes'),
      this.getBondMode());
  },
  getBondMode() {
    var ifc = this.props.interface;
    return ifc.get('mode') || (ifc.getAttributeValue('mode'));
  },
  getAvailableBondingModes() {
    var {configModels, bondingProperties} = this.props;
    var ifc = this.props.interface;
    var bondType = ifc.get('attributes').get('type__.value');
    var modes = bondingProperties[bondType].mode;

    var availableModes = [];
    var interfaces = ifc.isBond() ? ifc.getSlaveInterfaces() : [ifc];
    _.each(interfaces, (ifc) => {
      availableModes.push(_.reduce(modes, (result, modeSet) => {
        if (
          modeSet.condition &&
        !(new Expression(modeSet.condition, configModels, {strict: false}))
          .evaluate({interface: ifc})
        ) {
          return result;
        }
        return result.concat(modeSet.values);
      }, []));
    });
    return _.intersection(...availableModes);
  },
  getBondPropertyValues(propertyName, value) {
    var bondType = this.props.interface.get('attributes').get('type__.value');
    return _.flatten(_.pluck(this.props.bondingProperties[bondType][propertyName], value));
  },
  updateBondAttributes(sectionName, settingName, value) {
    var attributes = this.props.interface.get('attributes');
    attributes.set([sectionName, settingName, 'value'].join('.'), value);
    if (!this.isHashPolicyNeeded()) attributes.unset('xmit_hash_policy.value');
    if (!this.isLacpRateAvailable()) attributes.unset('lacp_rate.value');
  },
  bondingChanged(name, value) {
    this.props.interface.set({checked: value});
  },
  bondingModeChanged(name, value) {
    this.props.interface.set({mode: value});
    var attributes = this.props.interface.get('attributes');
    attributes.set('mode.value.value', value);
    this.updateBondAttributes('mode', 'value', value);
    if (this.isHashPolicyNeeded()) {
      this.updateBondAttributes('xmit_hash_policy', 'value',
        this.getBondPropertyValues('xmit_hash_policy', 'values')[0]);
    }
    if (this.isLacpRateAvailable()) {
      this.updateBondAttributes('lacp_rate', 'value',
          this.getBondPropertyValues('lacp_rate', 'values')[0]);
    }
  },
  onPolicyChange(name, value) {
    this.updateBondAttributes('xmit_hash_policy', 'value', value);
  },
  onLacpChange(name, value) {
    this.updateBondAttributes('lacp_rate', 'value', value);
  },
  getBondingOptions(bondingModes, attributeName) {
    return _.map(bondingModes, (mode) => {
      return (
        <option key={'option-' + mode} value={mode}>
          {i18n(ns + attributeName + '.' + mode.replace('.', '_'), {defaultValue: mode})}
        </option>
      );
    });
  },
  render() {
    var ifc = this.props.interface;
    var {cluster, locked, availableBondingTypes,
      configurationTemplateExists, viewMode,
      interfaceSpeeds, interfaceNames, errors} = this.props;
    var isBond = ifc.isBond();
    var availableBondingModes = isBond ? this.getAvailableBondingModes() : [];
    var networkConfiguration = cluster.get('networkConfiguration');
    var networks = networkConfiguration.get('networks');
    var networkingParameters = networkConfiguration.get('networking_parameters');
    var slaveInterfaces = ifc.getSlaveInterfaces();
    var assignedNetworks = ifc.get('assigned_networks');
    var connectionStatusClasses = (ifc) => {
      var isInterfaceDown = ifc.get('state') === 'down';
      return {
        'ifc-connection-status': true,
        'ifc-online': !isInterfaceDown,
        'ifc-offline': isInterfaceDown
      };
    };
    var attributes = ifc.get('attributes');
    var bondingPossible = !!availableBondingTypes.length && !configurationTemplateExists && !locked;
    var networkErrors = (_.flatten((errors || {}).network_errors || [])).join(', ');
    var hasPropertiesErrors = !_.isEmpty((errors || {}).interface_properties);
    var isCompact = viewMode === 'compact';
    var visibleErrors = _.compact([
      networkErrors,
      hasPropertiesErrors && isCompact && i18n(ns + 'interface_properties_errors')
    ]);
    var checkbox = bondingPossible ?
      <Input
        type='checkbox'
        label={!isCompact && ifc.get('name')}
        onChange={this.bondingChanged}
        checked={!!ifc.get('checked')}
      />
    :
      !isCompact && ifc.get('name');

    return this.props.connectDropTarget(
      <div className='ifc-container'>
        <div
          className={utils.classNames({
            'ifc-inner-container': true,
            nodrag: !!networkErrors,
            over: this.props.isOver && this.props.canDrop,
            'has-changes': this.props.hasChanges,
            [ifc.get('name')]: true,
            [viewMode]: true
          })}
        >
          {!isCompact &&
            <div className='ifc-header forms-box clearfix'>
              <div className={utils.classNames({
                'common-ifc-name pull-left': true,
                'no-checkbox': !bondingPossible
              })}>
                {checkbox}
              </div>
              {isBond && [
                <Input
                  key='bonding_mode'
                  type='select'
                  disabled={!bondingPossible}
                  onChange={this.bondingModeChanged}
                  value={this.getBondMode()}
                  label={i18n(ns + 'bonding_mode')}
                  children={this.getBondingOptions(availableBondingModes, 'bonding_modes')}
                  wrapperClassName='pull-right'
                />,
                this.isHashPolicyNeeded() &&
                  <Input
                    key='bonding_policy'
                    type='select'
                    value={attributes.get('xmit_hash_policy.value.value')}
                    disabled={!bondingPossible}
                    onChange={this.onPolicyChange}
                    label={i18n(ns + 'bonding_policy')}
                    children={this.getBondingOptions(
                      this.getBondPropertyValues('xmit_hash_policy', 'values'),
                      'hash_policy'
                    )}
                    wrapperClassName='pull-right'
                  />,
                this.isLacpRateAvailable() &&
                  <Input
                    key='lacp_rate'
                    type='select'
                    value={attributes.get('lacp_rate.value.value')}
                    disabled={!bondingPossible}
                    onChange={this.onLacpChange}
                    label={i18n(ns + 'lacp_rate')}
                    children={this.getBondingOptions(
                      this.getBondPropertyValues('lacp_rate', 'values'),
                      'lacp_rates'
                    )}
                    wrapperClassName='pull-right'
                  />
              ]}
            </div>
          }
          <div className={utils.classNames({
            'networks-block': true,
            'col-xs-12': isCompact
          })}>
            <div className='row'>
              <div className='col-xs-3'>
                <div className='ifc-select pull-left'>
                  {isCompact && checkbox}
                  {_.map(isCompact ? [ifc] : slaveInterfaces, (renderedInterface, index) => {
                    return (
                      <div
                        key={'info-' + renderedInterface.get('name')}
                        className='ifc-info-block clearfix'
                        >
                        <div className='ifc-connection pull-left'>
                          <div className={utils.classNames(
                            connectionStatusClasses(renderedInterface)
                          )}></div>
                        </div>
                        <div className={utils.classNames({
                          'ifc-info pull-left': true,
                          'ifc-compact': isCompact && !isBond
                        })}>
                          {(isBond || isCompact) &&
                            <div>
                              {i18n(ns + 'name')}:
                              {' '}
                              <span className='ifc-name'>
                                {isCompact ? ifc.get('name') : interfaceNames[index]}
                              </span>
                            </div>
                          }
                          {isCompact ?
                            isBond &&
                              <div>
                                {i18n(ns + 'slaves')}:
                                {' '}
                                <span className='slaves-names'>
                                  {_.take(interfaceNames, 2).join(', ')}
                                  {interfaceNames.length > 2 && ', ...'}
                                </span>
                              </div>
                            :
                              ([
                                this.props.nodes.length === 1 &&
                                  <div key='mac'>
                                    {i18n(ns + 'mac')}: {renderedInterface.get('mac')}
                                  </div>,
                                <div key='speed'>
                                  {i18n(ns + 'speed')}: {interfaceSpeeds[index].join(', ')}
                                </div>,
                                (bondingPossible && slaveInterfaces.length >= 3) &&
                                  <button
                                    key='remove_from_bond'
                                    className='btn btn-link'
                                    onClick={_.partial(
                                          this.props.removeInterfaceFromBond,
                                          ifc.get('name'), renderedInterface.get('name')
                                        )}
                                    >
                                    {i18n('common.remove_button')}
                                  </button>
                              ])
                          }
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className='col-xs-9'>
                {!configurationTemplateExists &&
                  <div className='ifc-networks'>
                    {assignedNetworks.length ?
                      assignedNetworks.map((interfaceNetwork) => {
                        var network = interfaceNetwork.getFullNetwork(networks);
                        if (!network) return null;
                        return (
                          <DraggableNetwork
                            key={'network-' + network.id}
                            {... _.pick(this.props, ['locked', 'interface'])}
                            networkingParameters={networkingParameters}
                            interfaceNetwork={interfaceNetwork}
                            network={network}
                          />
                        );
                      })
                    :
                      <div className='no-networks'>
                        {i18n(ns + 'drag_and_drop_description')}
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
            {!!visibleErrors.length &&
              <div className='ifc-error alert alert-danger'>
                {_.map(visibleErrors, (error, index) => <p key={'error' + index}>{error}</p>)}
              </div>
            }
          </div>
          {!isCompact ?
            <NodeInterfaceAttributes
              {... _.pick(this.props, 'cluster', 'interface', 'nodesInterfaces',
                'limitations', 'locked', 'bondingProperties', 'validate')}
              isMassConfiguration={!!this.props.nodes.length}
              bondingModeChanged={this.bondingModeChanged}
              getAvailableBondingTypes={this.props.getAvailableBondingTypes}
            />
            :
            <div className='clearfix'></div>
          }
        </div>
      </div>
    );
  }
});

var NodeInterfaceDropTarget = DropTarget(
  'network',
  NodeInterface.target,
  NodeInterface.collect
)(NodeInterface);

var Network = React.createClass({
  statics: {
    source: {
      beginDrag(props) {
        return {
          networkName: props.network.get('name'),
          interfaceName: props.interface.get('name')
        };
      },
      canDrag(props) {
        return !(props.locked || props.network.get('meta').unmovable);
      }
    },
    collect(connect, monitor) {
      return {
        connectDragSource: connect.dragSource(),
        isDragging: monitor.isDragging()
      };
    }
  },
  render() {
    var network = this.props.network;
    var interfaceNetwork = this.props.interfaceNetwork;
    var networkingParameters = this.props.networkingParameters;
    var classes = {
      'network-block pull-left': true,
      disabled: !this.constructor.source.canDrag(this.props),
      dragging: this.props.isDragging
    };
    var vlanRange = network.getVlanRange(networkingParameters);

    return this.props.connectDragSource(
      <div className={utils.classNames(classes)}>
        <div className='network-name'>
          {i18n(
            'network.' + interfaceNetwork.get('name'),
            {defaultValue: interfaceNetwork.get('name')}
          )}
        </div>
        {vlanRange &&
          <div className='vlan-id'>
            {i18n(ns + 'vlan_id', {count: _.uniq(vlanRange).length})}:
            {_.uniq(vlanRange).join('-')}
          </div>
        }
      </div>
    );
  }
});

var DraggableNetwork = DragSource('network', Network.source, Network.collect)(Network);

var NodeInterfaceAttributes = React.createClass({
  mixins: [
    backboneMixin('interface'),
    backboneMixin({
      modelOrCollection: (props) => props.interface && props.interface.get('attributes')
    })
  ],
  componentDidMount() {
    $(ReactDOM.findDOMNode(this.refs['configuration-panel']))
      .on('show.bs.collapse', () => this.setState({pendingToggle: false, collapsed: false}))
      .on('hide.bs.collapse', () => this.setState({pendingToggle: false, collapsed: true}));
  },
  componentDidUpdate() {
    if (this.state.pendingToggle) {
      $(ReactDOM.findDOMNode(this.refs['configuration-panel'])).collapse('toggle');
    }
  },
  getInitialState() {
    return {
      activeInterfaceSectionName: null,
      pendingToggle: false,
      collapsed: true
    };
  },
  getRenderableSections() {
    var {interface: ifc, limitations} = this.props;
    var attributes = ifc.get('attributes');
    var attributeNames = _.keys(attributes.attributes);
    var meta = ifc.get('meta') || {};
    var sortedAttributes = attributeNames.filter((sectionName) => {
      if (attributes.get(utils.makePath(sectionName, 'type')) === 'hidden') {
        return false;
      }
      // some bond properties are not visible in tabbed interface
      var skipList = ['mode', 'lacp', 'lacp_rate', 'xmit_hash_policy'];
      if (_.includes(skipList, sectionName)) {
        return false;
      }
      if (!meta[sectionName] && _.some(_.values(limitations.key), (field) => field.shown)) {
        return true;
      }
      return _.isUndefined(meta[sectionName]) || meta[sectionName].available;
    }).sort((key1, key2) => {
      var section1 = attributes.get(key1);
      var section2 = attributes.get(key2);
      return (section1.metadata.weight || 100) - (section2.metadata.weight || 100);
    });
    return sortedAttributes;
  },
  switchActiveSubtab(sectionName) {
    var currentActiveTab = this.state.activeInterfaceSectionName;
    this.setState({
      pendingToggle: _.isNull(currentActiveTab) ||
        currentActiveTab === sectionName || this.state.collapsed,
      activeInterfaceSectionName: sectionName
    });
  },
  makeOffloadingModesExcerpt() {
    var states = {
      true: i18n('common.enabled'),
      false: i18n('common.disabled'),
      null: i18n('cluster_page.nodes_tab.configure_interfaces.offloading_default')
    };
    var ifcModes = this.props.interface.get('meta.offloading_modes') || [];
    var attributes = this.props.interface.get('attributes');
    var values = attributes.get('offloading.modes.value');
    if (ifcModes.length === 0) {
      return states[attributes.get('offloading.disable.value')];
    }

    if (_.uniq(_.map(ifcModes, (mode) => values[mode.name])).length === 1) {
      return states[values[ifcModes[0].name]];
    }

    var lastState;
    var added = 0;
    var excerpt = [];
    _.each(ifcModes,
        (mode) => {
          if (!_.isNull(mode.state) && values[mode.name] !== lastState) {
            lastState = values[mode.name];
            added++;
            excerpt.push((added > 1 ? ',' : '') + mode.name + ' ' + states[lastState]);
          }
          // show no more than two modes in the button
          if (added === 2) return false;
        }
    );
    if (added < ifcModes.length) excerpt.push(', ...');
    return excerpt;
  },
  changeBondType(newType) {
    this.props.interface.get('attributes').set('type__.value', newType);
    var newMode = _.flatten(
        _.pluck(this.props.bondingProperties[newType].mode, 'values')
    )[0];
    this.props.bondingModeChanged(null, newMode);
  },
  renderLockTooltip(property) {
    return <Tooltip key={property + '-unavailable'} text={i18n(ns + 'availability_tooltip')}>
      <span className='glyphicon glyphicon-lock' aria-hidden='true'></span>
    </Tooltip>;
  },
  renderConfigurableSections(renderableSections) {
    var ifc = this.props.interface;
    var attributes = ifc.get('attributes');
    var errors = attributes.validationError;
    var offloadingRestricted = false;
    var {activeInterfaceSectionName} = this.state;
    return (
      <div className='properties-list'>
        {_.map(renderableSections, (sectionName) => {
          var section = attributes.get(sectionName);
          var {metadata} = section;
          var settings = _.map(_.omit(section, 'metadata'),
            (value, key) => {
              var val = _.clone(value); val.key = key; return val;
            });
          var sectionClasses = {
            'property-item-container': true,
            active: sectionName === activeInterfaceSectionName && !this.state.collapsed,
            'text-danger': _.some(settings, (setting) => {
              return errors && errors[sectionName + '.' + setting.key];
            })
          };
          var defaultField = _.first(_.sortBy(settings, 'weight'));
          var {key: defaultKey, value: defaultValue} = defaultField;
          if (sectionName === 'offloading') {
            defaultValue = this.makeOffloadingModesExcerpt();
          } else if (defaultKey === 'disabled') {
            defaultValue = defaultValue ? 'Disabled' : 'Enabled';
          } else if (_.isNull(defaultValue) || defaultValue === '' || _.isNaN(defaultValue)) {
            defaultValue = i18n(ns + 'default_value');
          } else if (_.isBoolean(defaultValue)) {
            defaultValue = defaultValue ? 'Enabled' : 'Disabled';
          } else if (_.isObject(defaultValue)) {
            defaultValue = i18n(ns + 'custom_value');
          }
          return (
            <span key={metadata.label} className={utils.classNames(sectionClasses, sectionName)}>
              {sectionName === 'offloading' && offloadingRestricted &&
                this.renderLockTooltip('offloading')}
              {(metadata && metadata.label) || section.label}:
              <button
                className='btn btn-link property-item'
                onClick={() => this.switchActiveSubtab(sectionName)}
                disabled={offloadingRestricted}
              >
                {defaultValue}
              </button>
            </span>
          );
        })
        }
      </div>
    );
  },
  renderInterfaceSubtab() {
    var activeSection = this.state.activeInterfaceSectionName;
    if (!activeSection) {
      return null;
    }
    var ifc = this.props.interface;
    var attributes = ifc.get('attributes');
    var errors = attributes.validationError;
    if (activeSection === 'offloading') {
      return (
        <OffloadingModesSubtab
          interface={ifc}
          errors={errors}
          {..._.pick(this.props, 'locked')}
        />
      );
    } else if (activeSection === 'dpdk') {
      return (
        <DPDKSubtab
          interface={ifc}
          changeBondType={this.changeBondType}
          errors={errors}
          {..._.pick(this.props, 'nodesInterfaces', 'locked', 'getAvailableBondingTypes')}
        />
      );
    } else if (activeSection === 'sriov') {
      return (
        <SRIOVSubtab
          interface={ifc}
          errors={errors}
          {..._.pick(this.props, 'nodesInterfaces', 'locked')}
        />
      );
    }

    var sectionName = activeSection;
    var settingsToDisplay = _.keys(_.omit(attributes.get(activeSection), 'metadata'));
    var {cluster} = this.props;
    var configModels = {};

    return (
      <div className={utils.classNames('forms-box attributes', activeSection + '-section')}>
        {activeSection &&
          <SettingSection
            {... {sectionName, settingsToDisplay, cluster, configModels}}
            key={settingSectionKey}
            initialAttributes={[]}
            showHeader={false}
            onChange={(settingName, value) => {
              attributes.set(utils.makePath(activeSection, settingName, 'value'), value);
              ifc.trigger('change', ifc);
              this.props.validate();
            }}
            settings={attributes}
            checkRestrictions={() => {
              return {result: false, message: null};
            }}
          />
        }
      </div>
    );
  },
  render() {
    var isConfigurationModeOn = !_.isNull(this.state.activeInterfaceSectionName);
    var toggleConfigurationPanelClasses = utils.classNames({
      'glyphicon glyphicon-menu-down': true,
      rotate: !this.state.collapsed
    });
    var renderableSections = this.getRenderableSections();
    var defaultSubtab = _.find(renderableSections, (section) => {
      var sectionLimitations = _.get(this.props.limitations, section);
      return _.some(sectionLimitations, (limitation) => limitation && limitation.equal);
    });
    return (
      <div className='ifc-properties clearfix forms-box'>
        <div className='row'>
          <div className='col-xs-11'>
            {this.renderConfigurableSections(renderableSections)}
          </div>
          <div className='col-xs-1 toggle-configuration-control'>
            <i
              className={toggleConfigurationPanelClasses}
              onClick={() => this.switchActiveSubtab(
                isConfigurationModeOn ? this.state.activeInterfaceSectionName : defaultSubtab
              )}
            />
          </div>
        </div>
        <div className='row configuration-panel collapse' ref='configuration-panel'>
          <div className='col-xs-12 forms-box interface-sub-tab'>
            {this.renderInterfaceSubtab()}
          </div>
        </div>
      </div>
    );
  }
});

var OffloadingModesSubtab = React.createClass({
  mixins: [
    backboneMixin('interface'),
    backboneMixin({
      modelOrCollection: (props) => props.interface && props.interface.get('attributes')
    })
  ],
  toggleOffloading(name, value) {
    var {interface: ifc} = this.props;
    var attributes = ifc.get('attributes');
    attributes.set('offloading.disable.value', value);
  },
  render() {
    var {interface: ifc, locked} = this.props;
    var attributes = ifc.get('attributes');
    var disable = attributes.get('offloading.disable.value');
    var modes = attributes.get('offloading.modes.value');
    return (
      <div>
        {_.keys(modes).length ?
          <OffloadingModes
            attributes={attributes}
            offloadingModesMeta={ifc.get('meta.offloading_modes')}
            disabled={locked}
          />
          :
          <Input
            type='checkbox'
            label={i18n(ns + 'disable_offloading')}
            checked={!!disable}
            name='disable'
            onChange={this.toggleOffloading}
            disabled={locked}
            wrapperClassName='toggle-offloading'
          />
        }
      </div>
    );
  }
});

var DPDKSubtab = React.createClass({
  onChange(name, value) {
    var attributes = this.props.interface.get('attributes');
    attributes.set(name, value);
  },
  render() {
    var {errors, nodesInterfaces} = this.props;
    var currentInterface = this.props.interface;
    var isBond = currentInterface.isBond();
    var attributes = currentInterface.get('attributes');
    var currentDPDKValue = attributes.get('dpdk.enabled.value');
    var newBondType = isBond ?
      _.first(
        _.without(
          _.intersection(...
            // Gathering all available bonding types from all nodes interfaces
            _.map(nodesInterfaces, (ifc) => {
              var ifcAttributes = ifc.get('attributes');
              ifcAttributes.set('dpdk.enabled.value', !currentDPDKValue);
              var bondTypes = this.props.getAvailableBondingTypes(ifc);
              ifcAttributes.set('dpdk.enabled.value', currentDPDKValue);
              return bondTypes;
            })
              // excluding the current one
          ), currentInterface.get('attributes').type__)
      )
      :
      null;
    return (
      <div className='dpdk-panel'>
        <div className='description'>{i18n(ns + 'dpdk_description')}</div>
        <Input
          type='checkbox'
          label={i18n('common.enabled')}
          checked={!!currentDPDKValue}
          name='dpdk.enabled'
          onChange={(propertyName, propertyValue) => {
            this.onChange('dpdk.enabled.value', propertyValue);
            if (isBond) this.props.changeBondType(newBondType);
          }}
          value={attributes.get('dpdk.enabled.value')}
          disabled={this.props.locked || isBond && !newBondType}
          tooltipText={isBond && !newBondType && i18n(ns + 'locked_dpdk_bond')}
          wrapperClassName='dpdk-control'
          error={errors && errors['dpdk.enabled']}
        />
      </div>
    );
  }
});

var SRIOVSubtab = React.createClass({
  onChange(name, value) {
    var attributes = this.props.interface.get('attributes');
    attributes.set(name, value);
  },
  render() {
    var {interface: ifc, errors} = this.props;
    var attributes = ifc.get('attributes');
    var meta = ifc.get('meta');
    var isSRIOVEnabled = attributes.get('sriov.enabled.value');
    var physnet = attributes.get('sriov.physnet.value');
    return (
      <div className='sriov-panel'>
        <div className='description'>{i18n(ns + 'sriov_description')}</div>
        <Input
          type='checkbox'
          label={i18n('common.enabled')}
          checked={!!isSRIOVEnabled}
          name='sriov.enabled.value'
          onChange={this.onChange}
          disabled={this.props.locked}
          wrapperClassName='sriov-control'
          error={errors && errors.common}
        />
        {isSRIOVEnabled && [
          <Input
            key='sriov.numvfs'
            type='number'
            min={0}
            max={meta.sriov.totalvfs}
            label={i18n(ns + 'virtual_functions')}
            value={attributes.get('sriov.numvfs.value')}
            name='sriov.numvfs.value'
            onChange={this.onChange}
            disabled={this.props.locked}
            wrapperClassName='sriov-virtual-functions'
            error={errors && errors.sriov_numvfs}
          />,
          <Input
            key='sriov.physnet'
            type='text'
            label={i18n(ns + 'physical_network')}
            value={physnet}
            name='sriov.physnet.value'
            onChange={this.onChange}
            disabled={this.props.locked}
            wrapperClassName='physnet'
            error={errors && errors.physnet}
            tooltipText={_.trim(physnet) && _.trim(physnet) !== 'physnet2' &&
              i18n(ns + 'validation.non_default_physnet')
            }
          />
        ]}
      </div>
    );
  }
});

export default EditNodeInterfacesScreen;

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

define([
  'intern!object',
  'intern/chai!assert',
  'tests/functional/helpers',
  'tests/functional/pages/common',
  'tests/functional/pages/modal'
], function(registerSuite, assert, helpers, Common, Modal) {
  registerSuite(function() {
    var common, modal;

    return {
      name: 'C842457',
      setup: function() {
        common = new Common(this.remote);
        modal = new Modal(this.remote);
        return this.remote
          .then(function() {
            return common.getIn();
          });
      },
      beforeEach: function() {
        var clusterName = common.pickRandomName('Temp');
        return this.remote
          .clickByCssSelector('.create-cluster')
          .then(function() {
            return modal.waitToOpen();
          })
          .setInputValue('[name=name]', clusterName);
      },
      'Test storage:image, -image:ceph, +storage:image': function() {
        var ceph = 'input[value=storage\\:image\\:ceph]';
        var swift = 'input[value=storage\\:image\\:swift]';

        return this.remote
          .pressKeys('\uE007')  // go to Compute
          .pressKeys('\uE007')  // Networking
          .pressKeys('\uE007')  // Storage

          // Check that Ceph image storage is inactive when swift image storage is
          // active and vice versa
          .clickByCssSelector('input[value=storage\\:image\\:cat]')
          .clickByCssSelector(ceph)
          .assertElementDisabled(swift, 'Swift is enabled with ceph')
          .clickByCssSelector(ceph)  // disable Ceph
          .clickByCssSelector(swift)
          .assertElementDisabled(ceph, 'Ceph is enabled with swift')
          .assertElementsExist('i.tooltip-icon.glyphicon-warning-sign' +
                               '[data-original-title="Not compatible with swift"]', 1,
                               'No warning that ceph is not compatible with swift')

          // Create cluster with qemu + Neutron vlan + Swift + cat
          .pressKeys('\uE007')  // Additional Services
          .pressKeys('\uE007')  // Finish
          .pressKeys('\uE007')  // Create
          .then(function() {
            return modal.waitToOpen().sleep(100);
          })

          // Delete created environment
          .clickByCssSelector('button.delete-environment-btn')
          .clickByCssSelector('button.remove-cluster-btn');
      }
    };
  });
});

// Ant Design 3/4/5 and the prefixed components used alongside Ant in older apps.
export const antDesign = {
    name: 'ant-design',
    form: { item: '.ant-form-item', label: '.ant-form-item-label label' },
    select: {
        shell: '.ant-select,.ant-cascader-picker',
        trigger: '.ant-select-selection,.ant-select-selector,.ant-cascader-picker',
        popup: '.ant-select-dropdown,.ant-cascader-menus,.ant-cascader-dropdown',
        option: '.ant-select-item-option,.ant-select-dropdown-menu-item,.ant-cascader-menu-item',
        ignore: '.ant-select-clear,.ant-select-selection__clear,.ant-select-selection__choice__remove,.ant-select-selection-item-remove',
    },
    dialog: '.ant-drawer-open .ant-drawer-content',
    table: { wrapper: '.ant-table-wrapper', pagination: '.ant-pagination' },
};

export const tntd = {
    name: 'tntd',
    form: { item: '.tntd-form-item', label: '.tntd-form-item-label label' },
    select: {
        shell: '.tntd-rc-select,.tntd-select,.tntd-cascader-picker',
        trigger:
            '.tntd-rc-select-selection,.tntd-rc-select-selector,.tntd-select-selection,.tntd-select-selector,.tntd-cascader-picker',
        popup: '.tntd-rc-select-dropdown,.tntd-select-dropdown,.tntd-cascader-menus,.tntd-cascader-dropdown,.tntd-virtual-tree-select-dropdown',
        option: '.tntd-rc-select-item-option,.tntd-select-item-option,.tntd-cascader-menu-item,.tntd-virtual-tree-select-dropdown .tntd-virtual-tree-title',
    },
};

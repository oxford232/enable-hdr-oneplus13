#!/system/bin/sh

# 此脚本在文件系统挂载后运行
# 对于简单的文件替换，KernelSU 的无系统覆盖通常会自动处理
# 此脚本主要用于高级场景，如设置特定权限/上下文
# 或者当默认覆盖对特定文件不起作用时

MODPATH="${0%/*}" # 模块目录路径
BACKUP_DIR="$MODPATH/backup" # 备份目录

# 调试日志（可选）
log_file="$MODPATH/log.txt"

# 目标文件和模块文件
TARGET_FILE="/my_product/vendor/etc/multimedia_display_feature_config.xml"
BACKUP_FILE="$BACKUP_DIR/multimedia_display_feature_config.xml"
MODULE_FILE="$MODPATH/multimedia_display_feature_config.xml"
APPLIST_FILE="$MODPATH/appList.xml"

# appList_new.xml 的新目标文件
TARGET_FILE_NEW="/my_product/vendor/etc/multimedia_display_uir_config.xml"
BACKUP_FILE_NEW="$BACKUP_DIR/multimedia_display_uir_config.xml"
MODULE_FILE_NEW="$MODPATH/multimedia_display_uir_config.xml"
APPLIST_FILE_NEW="$MODPATH/appList_new.xml"

if [ -f "$log_file" ]; then
    echo "删除日志文件: $log_file"
    rm "$log_file"
    echo "文件已删除"
else
    echo "日志文件不存在: $log_file"
fi
# 创建备份目录（如果不存在）
mkdir -p "$BACKUP_DIR"

# 备份原始文件
if [ ! -f "$BACKUP_FILE" ] && [ -f "$TARGET_FILE" ]; then
    cp "$TARGET_FILE" "$BACKUP_FILE"
fi

if [ ! -f "$BACKUP_FILE_NEW" ] && [ -f "$TARGET_FILE_NEW" ]; then
    cp "$TARGET_FILE_NEW" "$BACKUP_FILE_NEW"
fi

# 处理文件替换的函数，包含正确的权限和上下文设置
handle_file_replacement() {
    local target_file="$1"
    local backup_file="$2"
    local module_file="$3"
    local applist_file="$4"
    local pattern="$5"
    
    # 如果备份文件存在，则基于备份文件创建模块文件
    if [ -f "$backup_file" ] && [ -f "$applist_file" ]; then
        # 获取原始上下文
        local original_context=$(ls -Zd "$target_file" 2>/dev/null | awk '{print $1}')
        
        # 使用 awk 处理备份文件
        awk '
        NR==FNR {
            newapps = newapps $0 "\n"
            next
        }
        /<feature name="'"$pattern"'"/ {
            in_block = 1
        }
        in_block && /<application[^>]*\/>/ {
            next
        }
        in_block && /<application[^>]*><\/application>/ {
            next
        }
        in_block && /<\/feature>/ {
            printf "%s", newapps
            in_block = 0
        }
        { print }
        ' "$applist_file" "$backup_file" > "$module_file"
        
        # 设置权限和上下文
        if [ -n "$original_context" ]; then
            chcon "$original_context" "$module_file"
        fi
        chmod 0644 "$module_file"
        
        # 如果模块文件存在，则进行绑定挂载
        if [ -e "$module_file" ]; then
            mount -o bind "$module_file" "$target_file"
        fi
    fi
}

echo "$(date): post-fs-data.sh 已执行" >> "$log_file"

# 使用 appList.xml 处理 multimedia_display_feature_config.xml
if [ -f "$APPLIST_FILE" ] && [ -f "$BACKUP_FILE" ]; then
    handle_file_replacement "$TARGET_FILE" "$BACKUP_FILE" "$MODULE_FILE" "$APPLIST_FILE" "(OplusDolbyVision|HdrVision)"
fi

# 使用 appList_new.xml 处理 multimedia_display_uir_config.xml
if [ -f "$APPLIST_FILE_NEW" ] && [ -f "$BACKUP_FILE_NEW" ]; then
    # 获取原始上下文
    original_context=$(ls -Zd "$TARGET_FILE_NEW" 2>/dev/null | awk '{print $1}')
    
    # 使用 awk 处理备份文件 - 现在只添加新内容，不删除现有内容
    awk '
    NR==FNR {
        newapps = newapps $0 "\n"
        next
    }
    /<app_list>/ {
        in_applist = 1
        print
        next
    }
    in_applist && /<\/app_list>/ {
        # 在关闭 app_list 标签前添加新内容
        printf "%s", newapps
        print
        in_applist = 0
        next
    }
    { print }
    ' "$APPLIST_FILE_NEW" "$BACKUP_FILE_NEW" > "$MODULE_FILE_NEW"
    
    # 设置权限和上下文
    if [ -n "$original_context" ]; then
        chcon "$original_context" "$MODULE_FILE_NEW"
    fi
    chmod 0644 "$MODULE_FILE_NEW"
    
    # 如果模块文件存在，则进行绑定挂载
    if [ -e "$MODULE_FILE_NEW" ]; then
        mount -o bind "$MODULE_FILE_NEW" "$TARGET_FILE_NEW"
    fi
fi

# 记录最终状态
echo "模块文件状态：" >> "$log_file"
echo "- 功能配置文件: $(test -f "$MODULE_FILE" && echo "已创建" || echo "未创建")" >> "$log_file"
echo "- UIR 配置文件: $(test -f "$MODULE_FILE_NEW" && echo "已创建" || echo "未创建")" >> "$log_file"

# 始终成功退出
exit 0

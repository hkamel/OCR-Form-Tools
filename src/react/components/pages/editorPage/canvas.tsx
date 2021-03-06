// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { ReactElement } from "react";
import { Spinner, SpinnerSize } from "office-ui-fabric-react/lib/Spinner";
import { Label } from "office-ui-fabric-react/lib/Label";
import { IconButton } from "office-ui-fabric-react/lib/Button";
import {
    EditorMode, IAssetMetadata,
    IProject, IRegion, RegionType, AssetType, ILabelData, ILabel, ITag, IAsset, IFormRegion,
} from "../../../../models/applicationState";
import CanvasHelpers from "./canvasHelpers";
import { AssetPreview } from "../../common/assetPreview/assetPreview";
import { ImageMap } from "../../common/imageMap/imageMap";
import "./canvas.scss";
import Style from "ol/style/Style";
import Icon from "ol/style/Icon";
import Point from "ol/geom/Point";
import Stroke from "ol/style/Stroke";
import Fill from "ol/style/Fill";
import { OCRService, OcrStatus } from "../../../../services/ocrService";
import { Feature } from "ol";
import { Extent } from "ol/extent";
import { KeyboardBinding } from "../../common/keyboardBinding/keyboardBinding";
import { KeyEventType } from "../../common/keyboardManager/keyboardManager";
import _ from "lodash";
import Alert from "../../common/alert/alert";
import * as pdfjsLib from "pdfjs-dist";
import Polygon from "ol/geom/Polygon";
import HtmlFileReader from "../../../../common/htmlFileReader";
import { parseTiffData, renderTiffToCanvas, loadImageToCanvas } from "../../../../common/utils";
import { constants } from "../../../../common/constants";
import { CanvasCommandBar } from "./CanvasCommandBar";

// temp hack for enabling worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.js`;

export interface ICanvasProps extends React.Props<Canvas> {
    selectedAsset: IAssetMetadata;
    editorMode: EditorMode;
    project: IProject;
    lockedTags: string[];
    hoveredLabel: ILabel;
    children?: ReactElement<AssetPreview>;
    onAssetMetadataChanged?: (assetMetadata: IAssetMetadata) => void;
    onSelectedRegionsChanged?: (regions: IRegion[]) => void;
    onCanvasRendered?: (canvas: HTMLCanvasElement) => void;
    onRunningOCRStatusChanged?: (isRunning: boolean) => void;
}

export interface ICanvasState {
    currentAsset: IAssetMetadata;
    imageUri: string;
    imageWidth: number;
    imageHeight: number;
    numPages: number;
    currentPage: number;
    ocr: any;
    ocrForCurrentPage: any;
    pdfFile: any;
    tiffImages: any[];
    isError: boolean;
    errorTitle?: string;
    errorMessage: string;
    ocrStatus: OcrStatus;
    layers: any;
}

interface IRegionOrder {
    page: number;
    order: number;
}

export default class Canvas extends React.Component<ICanvasProps, ICanvasState> {
    public static defaultProps: ICanvasProps = {
        editorMode: EditorMode.Select,
        selectedAsset: null,
        project: null,
        lockedTags: [],
        hoveredLabel: null,
    };

    public state: ICanvasState = {
        currentAsset: this.props.selectedAsset,
        imageUri: null,
        imageWidth: 1024,
        imageHeight: 768,
        numPages: 1,
        currentPage: 1,
        ocr: null,
        ocrForCurrentPage: {},
        pdfFile: null,
        tiffImages: [],
        isError: false,
        errorMessage: undefined,
        ocrStatus: OcrStatus.done,
        layers: {text: true, tables: true},
    };

    private imageMap: ImageMap;

    private ocrService: OCRService;

    private selectedRegionIds: string[] = [];

    private regionOrders: Array<Record<string, number>> = [];

    private regionOrderById: string[][] = [];

    private lastKeyBoardRegionId: string;

    private applyTagFlag: boolean = false;

    private pendingFlag: boolean = false;

    public componentDidMount = async () => {
        this.ocrService = new OCRService(this.props.project);
        const asset = this.state.currentAsset.asset;
        await this.loadImage();
        await this.loadOcr();
        this.loadLabelData(asset);
    }

    public componentDidUpdate = async (prevProps: Readonly<ICanvasProps>, prevState: Readonly<ICanvasState>) => {
        // Handles asset changing
        if (this.props.selectedAsset.asset.name !== prevProps.selectedAsset.asset.name ||
            this.props.selectedAsset.asset.isRunningOCR !== prevProps.selectedAsset.asset.isRunningOCR) {
            this.selectedRegionIds = [];
            this.imageMap.removeAllFeatures();
            this.setState({
                currentAsset: this.props.selectedAsset,
                ocr: null,
                ocrForCurrentPage: {},
                numPages: 1,
                currentPage: 1,
                pdfFile: null,
                imageUri: null,
                tiffImages: [],
                layers: { tables : true, text: true },
            }, async () => {
                const asset = this.state.currentAsset.asset;
                await this.loadImage();
                await this.loadOcr();
                this.loadLabelData(asset);
            });
        } else if (this.isLabelDataChanged(this.props, prevProps)) {
            this.redrawFeatures(this.imageMap.getAllFeatures());
            const newRegions = this.convertLabelDataToRegions(this.props.selectedAsset.labelData);
            this.updateAssetRegions(newRegions);
        }

        if (this.props.hoveredLabel !== prevProps.hoveredLabel) {
            this.imageMap.getAllFeatures().map(this.updateHighlightStatus);
        }
    }

    public render = () => {

        return (
            <div style={{ width: "100%", height: "100%" }}>
                <KeyboardBinding
                        displayName={"Delete region"}
                        key={"Delete"}
                        keyEventType={KeyEventType.KeyDown}
                        accelerators={["Delete", "Backspace", "<", ",", ">", ".",
                            "{", "[", "}", "]", "+", "-", "/", "=", "_", "?"]}
                        handler={this.handleKeyDown}
                />
                <CanvasCommandBar
                    handleLayerChange={this.handleLayerChange}
                    handleZoomIn={this.handleCanvasZoomIn}
                    handleZoomOut={this.handleCanvasZoomOut}
                    layers={this.state.layers}
                />
                <ImageMap
                    ref={(ref) => this.imageMap = ref}
                    imageUri={this.state.imageUri}
                    imageWidth={this.state.imageWidth}
                    imageHeight={this.state.imageHeight}
                    enableFeatureSelection={true}
                    handleTextFeatureSelect={this.handleTextFeatureSelect}
                    handleTableFeatureSelect={this.handleTableFeatureSelect}
                    featureStyler={this.featureStyler}
                    tableFeatureStyler={this.tableFeatureStyler}
                    onMapReady={this.noOp}
                />
                { this.shouldShowPreviousPageButton() &&
                    <IconButton
                        className="toolbar-btn prev"
                        title="Previous"
                        iconProps={{iconName: "ChevronLeft"}}
                        onClick={this.prevPage}
                    />
                }
                { this.shouldShowNextPageButton() &&
                    <IconButton
                        className="toolbar-btn next"
                        title="Next"
                        onClick={this.nextPage}
                        iconProps={{iconName: "ChevronRight"}}
                    />
                }
                { this.shouldShowMultiPageIndicator() &&
                    <p className="page-number">
                        Page {this.state.currentPage} of {this.state.numPages}
                    </p>
                }
                { this.state.ocrStatus !== OcrStatus.done &&
                    <div className="canvas-ocr-loading">
                        <div className="canvas-ocr-loading-spinner">
                            <Label className="p-0" ></Label>
                            <Spinner size={SpinnerSize.large} label="Running OCR..." ariaLive="assertive" labelPosition="right"/>
                        </div>
                    </div>
                }
                <Alert
                    show={this.state.isError}
                    title={this.state.errorTitle || "Error"}
                    message={this.state.errorMessage}
                    onClose={() => this.setState({
                        isError: false,
                        errorTitle: undefined,
                        errorMessage: undefined,
                    })}
                />
            </div>
        );
    }

    /**
     * Toggles tag on all selected regions
     * @param selectedTag Tag name
     */
    public applyTag = (tag: string) => {
        const selectedRegions = this.getSelectedRegions();
        const regionsEmpty = !selectedRegions || !selectedRegions.length;
        if (!tag || regionsEmpty) {
            return;
        }

        if (this.showMultiPageFieldWarningIfNecessary(tag, selectedRegions)) {
            return;
        }

        const transformer: (tags: string[], tag: string) => string[] = CanvasHelpers.setSingleTag;
        for (const selectedRegion of selectedRegions) {
            selectedRegion.tags = transformer(selectedRegion.tags, tag);
        }

        this.updateRegions(selectedRegions);

        this.selectedRegionIds = [];
        if (this.props.onSelectedRegionsChanged) {
            this.props.onSelectedRegionsChanged([]);
        }

        this.redrawFeatures(this.imageMap.getAllFeatures());
        this.applyTagFlag = true;
    }

    private getSelectedRegions = (): IRegion[] => {
        return this.state.currentAsset.regions.filter((r) => this.selectedRegionIds.find((id) => r.id === id));
    }

    private addRegions = (regions: IRegion[]) => {
        this.addRegionsToAsset(regions);
        this.addRegionsToImageMap(regions.filter((region) => region.pageNumber === this.state.currentPage));
    }

    private addRegionsToAsset = (regions: IRegion[]) => {
        const regionsToBeKept = this.state.currentAsset.regions.filter((assetRegion) => {
            return regions.findIndex((r) => r.id === assetRegion.id) === -1;
        });
        this.updateAssetRegions(regionsToBeKept.concat(regions));
    }

    private addRegionsToImageMap = (regions: IRegion[]) => {
        if (this.imageMap == null) {
            return;
        }
        const allFeatures = this.imageMap.getAllFeatures();
        const regionsNotInFeatures = regions.filter((region) =>
            allFeatures.findIndex((feature) => feature.get("id") === region.id) === -1);
        const imageExtent = this.imageMap.getImageExtent();
        const featuresToAdd = regionsNotInFeatures.map((region) => this.convertRegionToFeature(region, imageExtent));
        this.imageMap.addFeatures(featuresToAdd);
    }

    private convertRegionToFeature = (region: IRegion, imageExtent: Extent, isOcrProposal: boolean = false) => {
        const coordinates = [];
        const boundingBox = region.id.split(",").map(parseFloat);
        const imageWidth = imageExtent[2] - imageExtent[0];
        const imageHeight = imageExtent[3] - imageExtent[1];
        for (let i = 0; i < boundingBox.length; i += 2) {
            coordinates.push([
                Math.round(boundingBox[i] * imageWidth),
                Math.round((1 - boundingBox[i + 1]) * imageHeight),
            ]);
        }

        const feature = new Feature({
            geometry: new Polygon([coordinates]),
        });
        feature.setProperties({
            id: region.id,
            text: region.value,
            highlighted: false,
            isOcrProposal,
        });
        feature.setId(region.id);

        return feature;
    }

    private deleteRegions = (regions: IRegion[]) => {
        this.deleteRegionsFromSelectedRegionIds(regions);
        this.deleteRegionsFromAsset(regions);
        this.deleteRegionsFromImageMap(regions);
    }

    private deleteRegionsFromSelectedRegionIds = (regions: IRegion[]) => {
        regions.forEach((region) => {
            const regionIndex = this.getIndexOfSelectedRegionIndex(region.id);
            if (regionIndex >= 0) {
                this.selectedRegionIds.splice(regionIndex, 1);
            }
        });
    }

    private deleteRegionsFromAsset = (regions: IRegion[]) => {
        const filteredRegions = this.state.currentAsset.regions.filter((assetRegion) => {
            return regions.findIndex((r) => r.id === assetRegion.id) === -1;
        });
        this.updateAssetRegions(filteredRegions);
    }

    private deleteRegionsFromImageMap = (regions: IRegion[]) => {
        if (this.imageMap == null) {
            return;
        }

        const allFeatures = this.imageMap.getAllFeatures();
        const selectedFeatures = allFeatures
            .filter((feature) => !feature.get("isOcrProposal"))
            .filter((feature) => regions.findIndex((region) => region.id === feature.get("id")) !== -1);
        selectedFeatures.map(this.imageMap.removeFeature);
        this.redrawFeatures(this.imageMap.getAllFeatures());
    }

    /**
     * Update regions within the current asset
     * @param regions
     * @param selectedRegions
     */
    private updateAssetRegions = (regions: IRegion[]) => {
        const labelData = this.convertRegionsToLabelData(regions, this.state.currentAsset.asset.name);
        const currentAsset: IAssetMetadata = {
            ...this.state.currentAsset,
            regions,
            labelData,
        };
        this.setState({
            currentAsset,
        }, () => {
            this.props.onAssetMetadataChanged(currentAsset);
        });
    }

    /**
     * Method called when deleting a region from the editor
     * @param {string} id the id of the deleted region
     * @returns {void}
     */
    private onRegionDelete = (id: string) => {
        // Remove from project
        const currentRegions = this.state.currentAsset.regions;
        const deletedRegionIndex = currentRegions.findIndex((region) => region.id === id);
        currentRegions.splice(deletedRegionIndex, 1);

        this.updateAssetRegions(currentRegions);
    }

    /**
     * Method called when deleting a region from the editor
     * @param {string} id the id of the selected region
     * @param {boolean} multiSelect boolean whether region was selected with multi selection
     * @returns {void}
     */
    private onRegionSelected = (id: string, multiSelect: boolean) => {
        const selectedRegions = this.getSelectedRegions();
        if (this.props.onSelectedRegionsChanged) {
            this.props.onSelectedRegionsChanged(selectedRegions);
        }
    }

    /**
     * Updates regions in both Canvas Tools and the asset data store
     * @param updates Regions to be updated
     * @param updatedSelectedRegions Selected regions with any changes already applied
     */
    private updateRegions = (updates: IRegion[]) => {
        const regions = this.state.currentAsset.regions;
        const updatedRegions = [].concat(regions);
        for (const update of updates) {
            const region = regions.find((r) => r.id === update.id);
            if (region) {
                // skip
            } else {
                updatedRegions.push(update);
            }
        }

        updatedRegions.sort(this.compareRegionOrder);
        this.updateAssetRegions(updatedRegions);
    }

    private createBoundingBoxVectorFeature = (text, boundingBox, imageExtent, ocrExtent, page) => {
        const coordinates: any[] = [];
        const polygonPoints: number[] = [];
        const imageWidth = imageExtent[2] - imageExtent[0];
        const imageHeight = imageExtent[3] - imageExtent[1];
        const ocrWidth = ocrExtent[2] - ocrExtent[0];
        const ocrHeight = ocrExtent[3] - ocrExtent[1];

        for (let i = 0; i < boundingBox.length; i += 2) {
            // An array of numbers representing an extent: [minx, miny, maxx, maxy]
            coordinates.push([
                Math.round((boundingBox[i] / ocrWidth) * imageWidth),
                Math.round((1 - (boundingBox[i + 1] / ocrHeight)) * imageHeight),
            ]);

            polygonPoints.push(boundingBox[i] / ocrWidth);
            polygonPoints.push(boundingBox[i + 1] / ocrHeight);
        }

        const featureId = this.createRegionIdFromBoundingBox(polygonPoints, page);
        const feature = new Feature({
            geometry: new Polygon([coordinates]),
        });
        feature.setProperties({
            id: featureId,
            text,
            boundingbox: boundingBox,
            highlighted: false,
            isOcrProposal: true,
        });
        feature.setId(featureId);

        return feature;
    }

    private createBoundingBoxVectorTable = (boundingBox, imageExtent, ocrExtent, page) => {
        const coordinates: any[] = [];
        const polygonPoints: number[] = [];
        const imageWidth = imageExtent[2] - imageExtent[0];
        const imageHeight = imageExtent[3] - imageExtent[1];
        const ocrWidth = ocrExtent[2] - ocrExtent[0];
        const ocrHeight = ocrExtent[3] - ocrExtent[1];

        for (let i = 0; i < boundingBox.length; i += 2) {
            // An array of numbers representing an extent: [minx, miny, maxx, maxy]
            coordinates.push([
                Math.round((boundingBox[i] / ocrWidth) * imageWidth),
                Math.round((1 - (boundingBox[i + 1] / ocrHeight)) * imageHeight),
            ]);

            polygonPoints.push(boundingBox[i] / ocrWidth);
            polygonPoints.push(boundingBox[i + 1] / ocrHeight);
        }
        const tableID = this.createRegionIdFromBoundingBox(polygonPoints, page);
        const tableBorderID = tableID + ":border";
        const tableFeatures = {};
        tableFeatures["border"] = new Feature({
            geometry: new Polygon([coordinates]),
            id: tableBorderID,
            selected: false,
            boundingbox: boundingBox,
            type: "tableBorder",
        });
        tableFeatures["button"] = new Feature({
            geometry: new Point([coordinates[0][0] - 7, coordinates[0][1] - 4]),
            id: tableID,
            selected: false,
            boundingbox: boundingBox,
            type: "tableButton",
        });
        tableFeatures["border"].setId(tableBorderID);
        tableFeatures["button"].setId(tableID);
        return tableFeatures;
    }

    private tableFeatureStyler = (feature) => {
        if (feature.get("type") === "tableBorder") {
            if (feature.get("selected")) {
                return new Style({
                    stroke: new Stroke({
                        color: "black",
                        lineDash: [6, 6],
                        width: 2,
                    }),
                    fill: new Fill({
                        color: "rgba(217, 217, 217, 0.1)",
                    }),
                });

            } else {
                return new Style({
                    stroke: new Stroke({
                        width: 0.1,
                    }),
                    fill: new Fill({
                        color: "rgba(255, 255, 255, 0)",
                    }),
                });
            }
        } else if (feature.get("type") === "tableButton") {
            if (!feature.get("selected")) {
                return new Style({
                    image: new Icon({
                        scale: 0.5,
                        opacity: 0.45,
                        anchor: [.95, 0.15],
                        anchorXUnits: "fraction",
                        anchorYUnits: "fraction",
                        src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACkAAAAmCAYAAABZNrIjAAABhUlEQVRYR+1YQaqCUBQ9BYZOWkHQyEELSAJbQM7cQiMxmjTXkQtwEomjttAsF6AguoAGjQRX0CRRsI/yg/hlqV8w4b3xfe8ezn3nHN7rKYpy8zwP37o4jkNPkqSbaZrfihGSJHUQ5G63w2QyaZ3V0+mE1WqV43hi0rZt8DzfOkjHcTCfzzsMcr1eYzQatc5kGIbYbrevmWwd3QsA3VR3mXE/jiIT2WKxAEVRhUNIkgSWZSETQ7aq9qil7r/K03UdDMMUgrxer9hsNrgHRhkH+be6CcjfeRAmX13Mxu/k8XjEdDp9a5e+70MQhLxmuVxC0zTQNF24J4oiqKqK/X6f11Tt0U2fJIlTkwFi5nfiGld3ncgisVj3+UCyu0x2z2YzDIfDt2ZxuVzgum5eMx6PwbIs+v1+4Z40TXE+nxEEQV5TtQdJnJre/bTtickynwOPD3dRFCHLMgaDQSGmOI5hGAYOh0NeU7UHSRySOJ/+goiZlzHzqsprRd1NeVuT53Qncbrwsf8D9suXe5WWs/YAAAAASUVORK5CYII=",
                    }),
                });
            } else {
                return new Style({
                    image: new Icon({
                        scale: 0.5,
                        anchor: [.95, 0.15],
                        anchorXUnits: "fraction",
                        anchorYUnits: "fraction",
                        src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACkAAAAmCAYAAABZNrIjAAABhUlEQVRYR+1YQaqCUBQ9BYZOWkHQyEELSAJbQM7cQiMxmjTXkQtwEomjttAsF6AguoAGjQRX0CRRsI/yg/hlqV8w4b3xfe8ezn3nHN7rKYpy8zwP37o4jkNPkqSbaZrfihGSJHUQ5G63w2QyaZ3V0+mE1WqV43hi0rZt8DzfOkjHcTCfzzsMcr1eYzQatc5kGIbYbrevmWwd3QsA3VR3mXE/jiIT2WKxAEVRhUNIkgSWZSETQ7aq9qil7r/K03UdDMMUgrxer9hsNrgHRhkH+be6CcjfeRAmX13Mxu/k8XjEdDp9a5e+70MQhLxmuVxC0zTQNF24J4oiqKqK/X6f11Tt0U2fJIlTkwFi5nfiGld3ncgisVj3+UCyu0x2z2YzDIfDt2ZxuVzgum5eMx6PwbIs+v1+4Z40TXE+nxEEQV5TtQdJnJre/bTtickynwOPD3dRFCHLMgaDQSGmOI5hGAYOh0NeU7UHSRySOJ/+goiZlzHzqsprRd1NeVuT53Qncbrwsf8D9suXe5WWs/YAAAAASUVORK5CYII=",
                    }),
                });
            }

        }
    }

    private featureStyler = (feature) => {

            const regionId = feature.get("id");
            const tag: ITag = this.getTagFromRegionId(regionId);
            // Selected
            if (this.isRegionSelected(regionId)) {
                return new Style({
                    stroke: new Stroke({
                        color: "#6eff40",
                        width: 1,
                    }),
                    fill: new Fill({
                        color: "rgba(110, 255, 80, 0.4)",
                    }),
                });
            } else if (tag != null) {
                // Already tagged
                return new Style({
                    stroke: new Stroke({
                        color: tag.color,
                        width: feature.get("highlighted") ? 4 : 2,
                    }),
                    fill: new Fill({
                        color: "rgba(255, 255, 255, 0)",
                    }),
                });
            } else {
                // Unselected
                return new Style({
                    stroke: new Stroke({
                        color: "#fffc7f",
                        width: 1,
                    }),
                    fill: new Fill({
                        color: "rgba(255, 252, 127, 0.2)",
                    }),
                });
            }

    }

    private setFeatureProperty = (feature, propertyName, propertyValue, forced: boolean = false) => {
        if (forced || feature.get(propertyName) !== propertyValue) {
            feature.set(propertyName, propertyValue);
        }
    }

    private updateHighlightStatus = (feature: any): void => {
        if (this.props.hoveredLabel) {
            const label = this.props.hoveredLabel;
            const id = feature.get("id");
            if (label.value.find((region) =>
                id === this.createRegionIdFromBoundingBox(region.boundingBoxes[0], region.page))) {
                this.setFeatureProperty(feature, "highlighted", true);
            }
        } else if (feature.get("highlighted")) {
            this.setFeatureProperty(feature, "highlighted", false);
        }
    }

    private handleTextFeatureSelect = (feature: Feature, isToggle: boolean = true) => {
        const regionId = feature.get("id");
        if (isToggle && this.isRegionSelected(regionId)) {
            this.removeFromSelectedRegions(regionId);
        } else {
            const polygon = regionId.split(",").map(parseFloat);
            this.addToSelectedRegions(regionId, feature.get("text"), polygon);
        }
        this.redrawFeatures(this.imageMap.getAllFeatures());
    }

    private handleTableFeatureSelect = (feature: Feature, isToggle: boolean = true) => {
        if (feature.get("type") === "tableBorder") {
            return;
        } else if (feature.get("type") === "tableButton") {
            const tableBorder = this.imageMap.getTableFeatureByID(feature.get("id") + ":border");
            tableBorder.set("selected", !tableBorder.get("selected"));
            feature.set("selected", !feature.get("selected"));
            return;
        }
    }

    private removeFromSelectedRegions = (regionId: string) => {
        const iRegionId = this.getIndexOfSelectedRegionIndex(regionId);
        if (iRegionId >= 0) {
            const region = this.getSelectedRegions().find((r) => r.id === regionId);
            if (region && region.tags && region.tags.length === 0 ) {
                this.onRegionDelete(regionId);
            }
            this.selectedRegionIds.splice(iRegionId, 1);
            if (this.props.onSelectedRegionsChanged) {
                this.props.onSelectedRegionsChanged(this.getSelectedRegions());
            }
        }
    }

    private addToSelectedRegions = (regionId: string, text: string, polygon: number[]) => {
        let selectedRegion;
        if (this.isRegionSelected(regionId)) {
            // skip if it's already existed in selected regions
            return;
        } else if (this.getIndexOfCurrentRegions(regionId) !== -1) {
            selectedRegion = this.state.currentAsset.regions.find((region) => region.id === regionId);
            // Explicitly set pageNumber in order to fix incorrect page number
            selectedRegion.pageNumber = this.state.currentPage;

        } else {
            const regionBoundingBox = this.convertToRegionBoundingBox(polygon);
            const regionPoints = this.convertToRegionPoints(polygon);
            selectedRegion = {
                id: regionId,
                type: RegionType.Polygon,
                tags: [],
                boundingBox: regionBoundingBox,
                points: regionPoints,
                value: text,
                pageNumber: this.state.currentPage,
            };
            this.addRegions([selectedRegion]);
        }

        this.selectedRegionIds.push(regionId);
        this.onRegionSelected(regionId, false);
    }

    private isRegionSelected = (regionId: string) => {
        return this.getIndexOfSelectedRegionIndex(regionId) !== -1;
    }

    private getIndexOfSelectedRegionIndex = (regionId: string) => {
        return this.selectedRegionIds.findIndex((id) => id === regionId);
    }

    private getIndexOfCurrentRegions = (regionId: string) => {
        return this.state.currentAsset.regions.findIndex((region) => region.id === regionId);
    }

    private getTagFromRegionId = (id: string): ITag => {
        const iRegion = this.getIndexOfCurrentRegions(id);
        if (iRegion >= 0) {
            const tagName = this.state.currentAsset.regions[iRegion].tags[0];
            return this.props.project.tags.find((tag) => tag.name === tagName);
        }
        return null;
    }

    private loadImage = async () => {
        const asset = this.state.currentAsset.asset;
        if (asset.type === AssetType.Image) {
            const canvas = await loadImageToCanvas(asset.path);
            this.setState({
                imageUri: canvas.toDataURL(constants.convertedImageFormat, constants.convertedImageQuality),
                imageWidth: canvas.width,
                imageHeight: canvas.height,
            });
        } else if (asset.type === AssetType.TIFF) {
            await this.loadTiffFile(asset);
        } else if (asset.type === AssetType.PDF) {
            await this.loadPdfFile(asset.id, asset.path);
        }
    }

    private setOCRStatus = (ocrStatus: OcrStatus) => {
        this.setState({ ocrStatus }, () => {
            if (this.props.onRunningOCRStatusChanged) {
                this.props.onRunningOCRStatusChanged(ocrStatus === OcrStatus.runningOCR);
            }
        });
    }

    private loadOcr = async () => {
        const asset = this.state.currentAsset.asset;
        if (asset.isRunningOCR) {
            // Skip loading OCR this time since it's running. This will be triggered again once it's finished.
            return;
        }
        try {
            const ocr = await this.ocrService.getRecognizedText(asset.path, asset.name, this.setOCRStatus);
            if (asset.id === this.state.currentAsset.asset.id) {
                // since get OCR is async, we only set currentAsset's OCR
                this.setState({
                    ocr,
                    ocrForCurrentPage: this.getOcrResultForCurrentPage(ocr),
                }, () => {
                    this.buildRegionOrders();
                    this.drawOcr();
                });
            }
        } catch (error) {
            this.setState({
                isError: true,
                errorTitle: error.title,
                errorMessage: error.message,
            });
        }
    }

    private loadTiffFile = async (asset: IAsset) => {
        const assetArrayBuffer = await HtmlFileReader.getAssetArray(asset);
        const tiffImages = parseTiffData(assetArrayBuffer);
        this.loadTiffPage(tiffImages, this.state.currentPage);
    }

    private loadTiffPage = (tiffImages: any[], pageNumber: number) => {
        const tiffImage = tiffImages[pageNumber - 1];
        const canvas = renderTiffToCanvas(tiffImage);
        this.setState({
            imageUri: canvas.toDataURL(constants.convertedImageFormat, constants.convertedImageQuality),
            imageWidth: tiffImage.width,
            imageHeight: tiffImage.height,
            numPages: tiffImages.length,
            currentPage: pageNumber,
            tiffImages,
        });
    }

    private loadPdfFile = async (assetId, url) => {
        try {
            const pdf = await pdfjsLib.getDocument(url).promise;
            // Fetch current page
            if (assetId === this.state.currentAsset.asset.id) {
                await this.loadPdfPage(assetId, pdf, this.state.currentPage);
            }
        } catch (reason) {
            // PDF loading error
            console.error(reason);
        }
    }

    private loadPdfPage = async (assetId, pdf, pageNumber) => {
        const page = await pdf.getPage(pageNumber);
        const defaultScale = 2;
        const viewport = page.getViewport({ scale: defaultScale });

        // Prepare canvas using PDF page dimensions
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        // Render PDF page into canvas context
        const renderContext = {
            canvasContext: context,
            viewport,
        };

        await page.render(renderContext).promise;
        if (assetId === this.state.currentAsset.asset.id) {
            this.setState({
                imageUri: canvas.toDataURL(constants.convertedImageFormat, constants.convertedImageQuality),
                imageWidth: canvas.width,
                imageHeight: canvas.height,
                numPages: pdf.numPages,
                currentPage: pageNumber,
                pdfFile: pdf,
            });
        }
    }

    private nextPage = async () => {
        if ((this.state.pdfFile !== null || this.state.tiffImages.length !== 0)
            && this.state.currentPage < this.state.numPages) {
            await this.goToPage(this.state.currentPage + 1);
        }
    }

    private prevPage = async () => {
        if ((this.state.pdfFile !== null || this.state.tiffImages.length !== 0) && this.state.currentPage > 1) {
            await this.goToPage(this.state.currentPage - 1);
        }
    }

    private goToPage = async (targetPage: number) => {
        if (targetPage < 1 || targetPage > this.state.numPages) {
            // invalid page number, just return
        }

        // clean up selected regions in current page
        const selectedRegions = this.getSelectedRegions();
        this.deleteRegionsFromSelectedRegionIds(selectedRegions);

        // remove regions without tag from asset
        const selectedRegionsWithoutTag = selectedRegions.filter((region) => region.tags.length === 0);
        this.deleteRegionsFromAsset(selectedRegionsWithoutTag);
        this.deleteRegionsFromImageMap(selectedRegionsWithoutTag);

        // switch image
        await this.switchToTargetPage(targetPage);

        // switch OCR
        this.setState({
            ocrForCurrentPage: this.getOcrResultForCurrentPage(this.state.ocr),
        }, () => {
            this.imageMap.removeAllFeatures();
            this.drawOcr();
            this.loadLabelData(this.state.currentAsset.asset);
        });
    }

    private convertLabelDataToRegions = (labelData: ILabelData): IRegion[] => {
        const regions = [];

        if (labelData.labels) {
            labelData.labels.forEach((label) => {
                if (label.value) {
                    label.value.forEach((formRegion) => {
                        if (formRegion.boundingBoxes) {
                            formRegion.boundingBoxes.forEach((boundingBox, boundingBoxIndex) => {
                                const text = this.getBoundingBoxTextFromRegion(formRegion, boundingBoxIndex);
                                regions.push(this.createRegion(boundingBox, text, label.label, formRegion.page));
                            });
                        }
                    });
                }
            });
        }

        return regions;
    }

    private convertRegionsToLabelData = (regions: IRegion[], assetName: string) => {
        const labelData: ILabelData = {
            document: decodeURIComponent(assetName).split("/").pop(),
            labels: [],
        };

        const fieldNames = Array.from(new Set(regions
            .map((region) => region.tags[0])))
            .filter((name) => name !== undefined);

        fieldNames.forEach((fieldName) => {
            const label: ILabel = {
                    label: fieldName,
                    key: null,
                    value: [],
            };

            const regionsToConvert = regions.filter((region) => region.tags.indexOf(fieldName) !== -1);
            regionsToConvert.forEach((region) => {
                const boundingBox = region.id.split(",").map(parseFloat);
                label.value.push({
                    page: region.pageNumber,
                    text: region.value,
                    boundingBoxes: [boundingBox],
                });
            });

            labelData.labels.push(label);
        });

        return labelData;
    }

    private convertToRegionBoundingBox = (polygon: number[]) => {
        const xAxisValues = polygon.filter((value, index) => index % 2 === 0);
        const yAxisValues = polygon.filter((value, index) => index % 2 === 1);
        const left = Math.min(...xAxisValues);
        const top = Math.min(...yAxisValues);
        const right = Math.max(...xAxisValues);
        const bottom = Math.max(...yAxisValues);

        return {
            height: bottom - top,
            width: right - left,
            left,
            top,
        };
    }

    private getTableBoundingBox = (lines: []) => {
        const flattenedLines = [].concat(...lines);
        const xAxisValues = flattenedLines.filter((value, index) => index % 2 === 0);
        const yAxisValues = flattenedLines.filter((value, index) => index % 2 === 1);
        const left = Math.min(...xAxisValues);
        const top = Math.min(...yAxisValues);
        const right = Math.max(...xAxisValues);
        const bottom = Math.max(...yAxisValues);
        return([left, top, right, top, right, bottom, left, bottom]);
    }

    private convertToRegionPoints = (polygon: number[]) => {
        const points = [];
        for (let i = 0; i < polygon.length; i += 2) {
            points.push({x: polygon[i], y: polygon[i + 1]});
        }
        return points;
    }

    private handleKeyDown = (keyEvent) => {
        switch (keyEvent.key) {
            case "Delete":
            case "Backspace":
                this.deleteRegions(this.getSelectedRegions());
                break;

            case "<":
            case ",":
                this.prevPage();
                break;

            case ">":
            case ".":
                this.nextPage();
                break;

            case "}":
            case "]":
                if (!this.pendingFlag) {
                    this.pendingFlag = true;
                    setTimeout(() => {
                        this.getRegionWithKey(true);
                        this.pendingFlag = false;
                    }, 1);
                }
                break;

            case "{":
            case "[":
                if (!this.pendingFlag) {
                    this.pendingFlag = true;
                    setTimeout(() => {
                        this.getRegionWithKey(false);
                        this.pendingFlag = false;
                    }, 1);
                }
                break;

            case "+":
            case "=":
                this.handleCanvasZoomIn();
                break;

            case "-":
            case "_":
                this.handleCanvasZoomOut();
                break;

            case "/":
            case "?":
                this.handleZoomReset();
                break;

            default:
                break;
        }
    }

    private handleCanvasZoomIn = () => {
        this.imageMap.zoomIn();
    }

    private handleCanvasZoomOut = () => {
        this.imageMap.zoomOut();
    }

    private handleZoomReset = () => {
        this.imageMap.resetZoom();
    }

    private getRegionWithKey = (keyFlag: boolean) => {
        let lastSelectedId;
        const selectedRegion = this.getSelectedRegions();
        const currentPage = this.state.currentPage;
        let nextRegionId;
        if (!selectedRegion.length && !this.applyTagFlag) {
            nextRegionId = this.regionOrderById[this.state.currentPage - 1][0];
        } else if (!this.applyTagFlag) {
            lastSelectedId = selectedRegion.find((r) =>
                r.id === this.selectedRegionIds[this.selectedRegionIds.length - 1]).id;
            this.deleteRegionsFromSelectedRegionIds(selectedRegion);
            const removeList = this.state.currentAsset.regions.filter((r) => r.tags.length === 0);
            this.deleteRegionsFromAsset(removeList);
            if (keyFlag) {
                nextRegionId = this.getNextIdByOrder(lastSelectedId, currentPage);
            } else if (!keyFlag) {
                nextRegionId = this.getPrevIdByOrder(lastSelectedId, currentPage);
            }
        } else if (this.applyTagFlag) {
            lastSelectedId = this.lastKeyBoardRegionId;
            if (keyFlag) {
                nextRegionId = this.getNextIdByOrder(lastSelectedId, currentPage);
            } else if (!keyFlag) {
                nextRegionId = this.getPrevIdByOrder(lastSelectedId, currentPage);
            }
            this.applyTagFlag = false;
        }
        const allFeatures = this.imageMap.getAllFeatures();
        const nextFeature = allFeatures.find((f) => f.get("id") === (nextRegionId));
        const polygon = nextRegionId.split(",").map(parseFloat);
        this.addToSelectedRegions(nextRegionId, nextFeature.get("text"), polygon);
        this.redrawFeatures(allFeatures);
        this.lastKeyBoardRegionId = nextRegionId;
    }

    private getOcrResultForCurrentPage = (ocr: any): any => {
        if (!ocr || !this.state.imageUri) {
            return {};
        }

        if (ocr.analyzeResult && ocr.analyzeResult.readResults) {
            // OCR schema with analyzeResult/readResults property
            const ocrResultsForCurrentPage = {};
            if (ocr.analyzeResult.pageResults) {
                ocrResultsForCurrentPage["pageResults"] = ocr.analyzeResult.pageResults[this.state.currentPage - 1];
            }
            ocrResultsForCurrentPage["readResults"] = ocr.analyzeResult.readResults[this.state.currentPage - 1];
            return ocrResultsForCurrentPage;
        }

        return {};
    }

    private isLabelDataChanged = (newProps: ICanvasProps, prevProps: ICanvasProps): boolean => {
        const newLabels = _.get(newProps, "selectedAsset.labelData.labels", []) as ILabel[];
        const prevLabels = _.get(prevProps, "selectedAsset.labelData.labels", []) as ILabel[];

        if (newLabels.length !== prevLabels.length) {
            return true;
        } else if (newLabels.length > 0) {
            const newFieldNames = newLabels.map((label) => label.label);
            const prevFieldNames = prevLabels.map((label) => label.label);
            return !_.isEqual(newFieldNames.sort(), prevFieldNames.sort());
        }

        return false;
    }

    private getBoundingBoxTextFromRegion = (formRegion: IFormRegion, boundingBoxIndex: number) => {
        // get value from formRegion.text
        const regionValues = formRegion.text.split(" ");
        if (regionValues && regionValues.length > boundingBoxIndex) {
            return regionValues[boundingBoxIndex];
        }

        // cannot find any, return empty string.
        return "";
    }

    private loadLabelData = (asset: IAsset) => {
        if (asset.id === this.state.currentAsset.asset.id &&
            this.state.currentAsset.labelData != null) {
            const regionsFromLabelData = this.convertLabelDataToRegions(this.state.currentAsset.labelData);
            if (regionsFromLabelData.length > 0) {
                this.addRegions(regionsFromLabelData);
            }
        }
    }

    private showMultiPageFieldWarningIfNecessary = (tagName: string, regions: IRegion[]): boolean => {
        const existedRegionsWithSameTag = this.state.currentAsset.regions.filter(
            (region) => _.get(region, "tags[0]", "") === tagName);
        const regionsWithSameTag = existedRegionsWithSameTag.concat(regions);
        const pageCount = (new Set(regionsWithSameTag.map((region) => region.pageNumber))).size;
        if (pageCount > 1) {
            this.setState({
                isError: true,
                errorMessage: `Sorry, we don't support cross-page regions with the same tag.` +
                    ` You have regions with tag "${tagName}" across ${pageCount} pages.`,
            });
            return true;
        }

        return false;
    }

    private noOp = () => {
        // no operation
    }

    private getRegionOrder = (regionId): IRegionOrder => {
        let orderInfo: IRegionOrder = { page: 1, order: 0 };
        this.regionOrders.some((regions, pageNumber) => {
            const order = regions[regionId];
            if (order !== undefined) {
                orderInfo = { page: pageNumber + 1, order };
                return true;
            }
            return false;
        });

        return orderInfo;
    }

    private getNextIdByOrder = (id: string, currentPage: number) => {
        const currentIdList = this.regionOrderById[currentPage - 1];
        const currentIndex = currentIdList.indexOf(id);
        let nextIndex;
        if (currentIndex === currentIdList.length - 1) {
            nextIndex = 0;
        } else {
            nextIndex = currentIndex + 1;
        }
        return currentIdList[nextIndex];
    }

    private getPrevIdByOrder = (id: string, currentPage: number) => {
        const currentIdList = this.regionOrderById[currentPage - 1];
        const currentIndex = currentIdList.indexOf(id);
        let prevIndex;
        if (currentIndex === 0) {
            prevIndex = currentIdList.length - 1;
        } else {
            prevIndex = currentIndex - 1;
        }
        return currentIdList[prevIndex];
    }

    private compareRegionOrder = (r1, r2) => {
        const order1 = this.getRegionOrder(r1.id);
        const order2 = this.getRegionOrder(r2.id);

        if (order1.page === order2.page) {
            return order1.order > order2.order ? 1 : -1;
        } else if (order1.page > order2.page) {
            return 1;
        } else {
            return -1;
        }
    }

    private buildRegionOrders = () => {
        // Build order index here instead of building it during 'drawOcr' for two reasons.
        // 1. Build order index for all pages at once. This allow us to support cross page
        //    tagging if it's supported by FR service.
        // 2. Avoid rebuilding order index when users switch back and forth between pages.
        const ocrs = this.state.ocr;
        const ocrReadResults = (ocrs.recognitionResults || (ocrs.analyzeResult && ocrs.analyzeResult.readResults));
        const imageExtent = this.imageMap.getImageExtent();
        ocrReadResults.map((ocr) => {
            const ocrExtent = [0, 0, ocr.width, ocr.height];
            this.regionOrders[ocr.page - 1] = {};
            this.regionOrderById[ocr.page - 1] = [];
            let order = 0;
            if (ocr.lines) {
                ocr.lines.forEach((line) => {
                    if (line.words) {
                        line.words.forEach((word) => {
                            if (this.shouldDisplayOcrWord(word.text)) {
                                const feature = this.createBoundingBoxVectorFeature(
                                    word.text, word.boundingBox, imageExtent, ocrExtent, ocr.page);
                                this.regionOrders[ocr.page - 1][feature.getId()] = order++;
                                this.regionOrderById[ocr.page - 1].push(feature.getId());
                            }
                        });
                    }
                });
            }

            return ocr;
        });
    }

    private drawOcr = () => {
        const textFeatures = [];
        const tableFeatures = [];
        const ocrReadResults = this.state.ocrForCurrentPage["readResults"];
        const ocrPageResults = this.state.ocrForCurrentPage["pageResults"];
        const imageExtent = this.imageMap.getImageExtent();
        const ocrExtent = [0, 0, ocrReadResults.width, ocrReadResults.height];
        if (ocrReadResults.lines) {
            ocrReadResults.lines.forEach((line) => {
                if (line.words) {
                    line.words.forEach((word) => {
                        if (this.shouldDisplayOcrWord(word.text)) {
                            textFeatures.push(this.createBoundingBoxVectorFeature(
                                word.text, word.boundingBox, imageExtent, ocrExtent, ocrReadResults.page));
                        }
                    });
                }
            });
        }
        if (ocrPageResults && ocrPageResults.tables) {
            ocrPageResults.tables.forEach((table) => {
                if (table.cells) {
                    const tableBoundingBox = this.getTableBoundingBox(table.cells.map((cell) => cell.boundingBox));
                    const createdTableFeatures = this.createBoundingBoxVectorTable(
                        tableBoundingBox,
                        imageExtent,
                        ocrExtent,
                        ocrPageResults.page);
                    tableFeatures.push(createdTableFeatures["border"]);
                    tableFeatures.push(createdTableFeatures["button"]);
                }
            });
        }

        if (tableFeatures.length > 0) {
            this.imageMap.addTableFeatures(tableFeatures);
        }
        if (textFeatures.length > 0) {
            this.imageMap.addFeatures(textFeatures);
        }
    }

    private shouldDisplayOcrWord = (text: string) => {
        const regex = new RegExp(/^[_]+$/);
        return !text.match(regex);
    }

    private redrawFeatures = (features: Feature[]) => {
        features.forEach((feature) => feature.changed());
    }

    private createRegion(boundingBox: number[], text: string, tagName: string, pangeNumber: number) {
        const xAxisValues = boundingBox.filter((value, index) => index % 2 === 0);
        const yAxisValues = boundingBox.filter((value, index) => index % 2 === 1);
        const left = Math.min(...xAxisValues);
        const top = Math.min(...yAxisValues);
        const right = Math.max(...xAxisValues);
        const bottom = Math.max(...yAxisValues);

        const points = [];
        for (let i = 0; i < boundingBox.length; i += 2) {
            points.push({
                x: boundingBox[i],
                y: boundingBox[i + 1],
            });
        }

        const newRegion = {
            id: this.createRegionIdFromBoundingBox(boundingBox, pangeNumber),
            type: RegionType.Polygon,
            tags: [tagName],
            boundingBox: {
                height: bottom - top,
                width: right - left,
                left,
                top,
            },
            points,
            value: text,
            pageNumber: pangeNumber,
        };
        return newRegion;
    }

    private switchToTargetPage = async (targetPage: number) => {
        if (this.state.pdfFile !== null) {
            await this.loadPdfPage(this.state.currentAsset.asset.id, this.state.pdfFile, targetPage);
        } else if (this.state.tiffImages.length !== 0) {
            this.loadTiffPage(this.state.tiffImages, targetPage);
        }
    }

    private shouldShowPreviousPageButton = () => {
        return (this.state.pdfFile !== null || this.state.tiffImages.length !== 0) && this.state.currentPage !== 1;
    }

    private shouldShowNextPageButton = () => {
        return (this.state.pdfFile !== null || this.state.tiffImages.length !== 0)
            && this.state.currentPage !== this.state.numPages;
    }

    private shouldShowMultiPageIndicator = () => {
        return (this.state.pdfFile !== null || this.state.tiffImages.length !== 0) && this.state.numPages > 1;
    }

    private createRegionIdFromBoundingBox = (boundingBox: number[], page: number): string => {
        return boundingBox.join(",") + ":" + page;
    }

    private handleLayerChange = async (layer: string) => {
        switch (layer) {
            case "text":
                this.imageMap.toggleTextFeatureVisibility();
                break;
            case "tables":
                this.imageMap.toggleTableFeatureVisibility();
                break;
        }
        const newLayers = Object.assign({}, this.state.layers);
        newLayers[layer] = !newLayers[layer];
        this.setState({
            layers : newLayers,
        });
    }
}
